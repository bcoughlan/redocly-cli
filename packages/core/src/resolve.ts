import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as yaml from 'js-yaml';
const { readFile } = fs.promises;
import { OasRef } from './typings/openapi';
import { isRef, joinPointer, escapePointer, parseRef, isAbsoluteUrl } from './ref-utils';
import { safeLoad as safeLoadToAst, YAMLNode, Kind } from 'yaml-ast-parser';
import { NormalizedNodeType, isNamedType } from './types';
import { readFileFromUrl } from './utils';
import { ResolveConfig } from './config/config';

export type CollectedRefs = Map<string /* absoluteFilePath */, Document>;

export class Source {
  constructor(public absoluteRef: string, public body: string, public mimeType?: string) {}

  private _ast: YAMLNode | undefined;
  private _lines: string[] | undefined;

  getAst() {
    if (this._ast === undefined) {
      this._ast = safeLoadToAst(this.body, { filename: this.absoluteRef }) ?? undefined;

      // fix ast representation of file with newlines only
      if (
        this._ast &&
        this._ast.kind === Kind.SCALAR &&
        this._ast.value === '' &&
        this._ast.startPosition !== 1
      ) {
        this._ast.startPosition = 1;
        this._ast.endPosition = 1;
      }
    }
    return this._ast;
  }

  getLines() {
    if (this._lines === undefined) {
      this._lines = this.body.split(/\r\n|[\n\r]/g);
    }
    return this._lines;
  }
}

export class ResolveError extends Error {
  constructor(public originalError: Error) {
    super(originalError.message);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, ResolveError.prototype);
  }
}

const jsYamlErrorLineColRegexp = /at line (\d+), column (\d+):/;

export class YamlParseError extends Error {
  col: number;
  line: number;

  constructor(public originalError: Error, public source: Source) {
    super(originalError.message.split('\n')[0]);
    // Set the prototype explicitly.
    Object.setPrototypeOf(this, YamlParseError.prototype);

    const [, line, col] = this.message.match(jsYamlErrorLineColRegexp) || [];
    this.line = parseInt(line, 10);
    this.col = parseInt(col, 10);
  }
}

export type Document = {
  source: Source;
  parsed: any;
};

export class BaseResolver {
  cache: Map<string, Promise<Document | ResolveError>> = new Map();

  constructor(private config: ResolveConfig = { http: { headers: [] } }) {}

  getFiles() {
    return new Set(Array.from(this.cache.keys()));
  }

  resolveExternalRef(base: string | null, ref: string): string {
    if (isAbsoluteUrl(ref)) {
      return ref;
    }

    if (base && isAbsoluteUrl(base)) {
      return url.resolve(base, ref);
    }

    return path.resolve(base ? path.dirname(base) : process.cwd(), ref);
  }

  async loadExternalRef(absoluteRef: string): Promise<Source> {
    try {
      if (isAbsoluteUrl(absoluteRef)) {
        const { body, mimeType } = await readFileFromUrl(absoluteRef, this.config.http);
        return new Source(absoluteRef, body, mimeType);
      } else {
        return new Source(absoluteRef, await readFile(absoluteRef, 'utf-8'));
      }
    } catch (error) {
      throw new ResolveError(error);
    }
  }

  parseDocument(source: Source): Document {
    const ext = source.absoluteRef.substr(source.absoluteRef.lastIndexOf('.'));
    if (
      !['.json', '.json', '.yml', '.yaml'].includes(ext) &&
      !source.mimeType?.match(/(json|yaml)/)
    ) {
      return { source, parsed: source.body };
    }

    try {
      return {
        source,
        parsed: yaml.safeLoad(source.body, { filename: source.absoluteRef }),
      };
    } catch (e) {
      throw new YamlParseError(e, source);
    }
  }

  async resolveDocument(
    base: string | null,
    ref: string,
  ): Promise<Document | ResolveError | YamlParseError> {
    const absoluteRef = this.resolveExternalRef(base, ref);
    const cachedDocument = this.cache.get(absoluteRef);
    if (cachedDocument) {
      return cachedDocument;
    }

    const doc = this.loadExternalRef(absoluteRef).then((source) => {
      return this.parseDocument(source);
    });

    this.cache.set(absoluteRef, doc);

    return doc;
  }
}

export type ResolvedRef =
  | {
      resolved: false;
      isRemote: boolean;
      nodePointer?: string;
      document?: Document;
      source?: Source;
      error?: ResolveError | YamlParseError;
      node?: any;
    }
  | {
      resolved: true;
      node: any;
      document: Document;
      nodePointer: string;
      isRemote: boolean;
      error?: undefined;
    };

export type ResolvedRefMap = Map<string, ResolvedRef>;

type RefFrame = {
  prev: RefFrame | null;
  node: any;
};

function pushRef(head: RefFrame, node: any): RefFrame {
  return {
    prev: head,
    node,
  };
}

function hasRef(head: RefFrame | null, node: any): boolean {
  while (head) {
    if (head.node === node) {
      return true;
    }
    head = head.prev;
  }
  return false;
}

const unknownType = { name: 'unknown', properties: {} };
const resolvableScalarType = { name: 'scalar', properties: {} };

export async function resolveDocument(opts: {
  rootDocument: Document;
  externalRefResolver: BaseResolver;
  rootType: NormalizedNodeType;
}): Promise<ResolvedRefMap> {
  const { rootDocument, externalRefResolver, rootType } = opts;

  const resolvedRefMap: ResolvedRefMap = new Map();
  const seedNodes = new Set<string>(); // format "${type}::${absoluteRef}${pointer}"

  const resolvePromises: Array<Promise<void>> = [];
  resolveRefsInParallel(rootDocument.parsed, rootDocument, '#/', rootType);

  let resolved;
  do {
    resolved = await Promise.all(resolvePromises);
  } while (resolvePromises.length !== resolved.length);

  return resolvedRefMap;

  function resolveRefsInParallel(
    rootNode: any,
    rootNodeDocument: Document,
    rootNodePointer: string,
    type: any,
  ) {
    const rootNodeDocAbsoluteRef = rootNodeDocument.source.absoluteRef;

    walk(rootNode, type, rootNodeDocAbsoluteRef + rootNodePointer);

    function walk(node: any, type: NormalizedNodeType, nodeAbsoluteRef: string) {
      if (typeof node !== 'object' || node === null) {
        return;
      }

      const nodeId = `${type.name}::${nodeAbsoluteRef}`;
      if (seedNodes.has(nodeId)) {
        return;
      }

      seedNodes.add(nodeId);

      if (Array.isArray(node)) {
        const itemsType = type.items;
        // we continue resolving unknown types, but stop early on known scalars
        if (type !== unknownType && itemsType === undefined) {
          return;
        }
        for (let i = 0; i < node.length; i++) {
          walk(node[i], itemsType || unknownType, joinPointer(nodeAbsoluteRef, i));
        }
        return;
      }

      for (const propName of Object.keys(node)) {
        let propValue = node[propName];

        let propType = type.properties[propName];
        if (propType === undefined) propType = type.additionalProperties;
        if (typeof propType === 'function') propType = propType(propValue, propName);
        if (propType === undefined) propType = unknownType;
        if (propType && propType.name === undefined && propType.referenceable) {
          propType = resolvableScalarType;
        }
        if (!isNamedType(propType) && propType?.directResolveAs) {
          propType = propType.directResolveAs;
          propValue = { $ref: propValue };
        }

        if (!isNamedType(propType)) {
          continue;
        }

        walk(propValue, propType, joinPointer(nodeAbsoluteRef, escapePointer(propName)));
      }

      if (isRef(node)) {
        const promise = followRef(rootNodeDocument, node, {
          prev: null,
          node,
        }).then((resolvedRef) => {
          if (resolvedRef.resolved) {
            resolveRefsInParallel(
              resolvedRef.node,
              resolvedRef.document,
              resolvedRef.nodePointer!,
              type,
            );
          }
        });
        resolvePromises.push(promise);
      }
    }

    async function followRef(
      document: Document,
      ref: OasRef,
      refStack: RefFrame,
    ): Promise<ResolvedRef> {
      if (hasRef(refStack.prev, ref)) {
        throw new Error('Self-referencing circular pointer');
      }

      const { uri, pointer } = parseRef(ref.$ref);
      const isRemote = uri !== null;
      let targetDoc: Document;
      try {
        targetDoc = isRemote
          ? ((await externalRefResolver.resolveDocument(document.source.absoluteRef, uri!)) as Document)
          : document;
      } catch (error) {
        const resolvedRef = {
          resolved: false as false,
          isRemote,
          document: undefined,
          error: error,
        };

        const refId = document.source.absoluteRef + '::' + ref.$ref;
        resolvedRefMap.set(refId, resolvedRef);

        return resolvedRef;
      }

      let resolvedRef: ResolvedRef = {
        resolved: true as true,
        document: targetDoc,
        isRemote,
        node: document.parsed,
        nodePointer: '#/',
      };

      let target = targetDoc.parsed as any;

      const segments = pointer;
      for (let segment of segments) {
        if (typeof target !== 'object') {
          target = undefined;
          break;
        } else if (target[segment] !== undefined) {
          target = target[segment];
          resolvedRef.nodePointer = joinPointer(resolvedRef.nodePointer!, escapePointer(segment));
        } else if (isRef(target)) {
          resolvedRef = await followRef(targetDoc, target, pushRef(refStack, target));
          target = resolvedRef.node[segment];
          resolvedRef.nodePointer = joinPointer(resolvedRef.nodePointer!, escapePointer(segment));
        } else {
          target = undefined;
          break;
        }
      }

      resolvedRef.node = target;

      const refId = document.source.absoluteRef + '::' + ref.$ref;

      if (resolvedRef.document && isRef(target)) {
        resolvedRef = await followRef(resolvedRef.document, target, pushRef(refStack, target));
      }
      resolvedRefMap.set(refId, resolvedRef);

      return { ...resolvedRef };
    }
  }
}
