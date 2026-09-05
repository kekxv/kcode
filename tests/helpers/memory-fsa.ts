type Node = DirectoryNode | FileNode;
type DirectoryNode = { kind: 'directory'; entries: Map<string, Node>; modified: number };
type FileNode = { kind: 'file'; bytes: Uint8Array; modified: number };

const clone = (value: Uint8Array): Uint8Array => new Uint8Array(value);
const missing = (name: string): DOMException => new DOMException(name, 'NotFoundError');
const exists = (name: string): DOMException => new DOMException(name, 'InvalidModificationError');
const wrongType = (name: string): DOMException => new DOMException(name, 'TypeMismatchError');

class MemoryFile implements Pick<FileSystemFileHandle, 'kind' | 'name' | 'getFile' | 'createWritable'> {
  readonly kind = 'file' as const;
  constructor(readonly name: string, readonly node: FileNode) {}

  async getFile(): Promise<File> {
    const file = new File([this.node.bytes.buffer.slice(this.node.bytes.byteOffset, this.node.bytes.byteOffset + this.node.bytes.byteLength) as ArrayBuffer], this.name, { lastModified: this.node.modified });
    return file;
  }

  async createWritable(options: FileSystemCreateWritableOptions = {}): Promise<FileSystemWritableFileStream> {
    let bytes = options.keepExistingData ? clone(this.node.bytes) : new Uint8Array();
    let position = 0;
    const write = async (data: FileSystemWriteChunkType): Promise<void> => {
      if (typeof data === 'object' && data !== null && 'type' in data) {
        const command = data as unknown as { type: string; position?: number; size?: number; data?: FileSystemWriteChunkType };
        if (command.type === 'seek') { position = Number(command.position); return; }
        if (command.type === 'truncate') { bytes = bytes.slice(0, Number(command.size)); return; }
        if (command.type === 'write') { position = Number(command.position ?? position); data = command.data!; }
      }
      const incoming = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new TextEncoder().encode(String(data));
      const end = position + incoming.byteLength;
      if (end > bytes.byteLength) { const expanded = new Uint8Array(end); expanded.set(bytes); bytes = expanded; }
      bytes.set(incoming, position);
      position = end;
    };
    return { write, seek: async (offset: number) => { position = offset; }, truncate: async (size: number) => { bytes = bytes.slice(0, size); }, close: async () => { this.node.bytes = bytes; this.node.modified = Date.now(); }, abort: async () => {} } as unknown as FileSystemWritableFileStream;
  }
}

class MemoryDirectory implements Pick<FileSystemDirectoryHandle, 'kind' | 'name' | 'getFileHandle' | 'getDirectoryHandle' | 'removeEntry'> {
  readonly kind = 'directory' as const;
  constructor(readonly name: string, readonly node: DirectoryNode) {}
  async getFileHandle(name: string, options: FileSystemGetFileOptions = {}): Promise<FileSystemFileHandle> {
    const found = this.node.entries.get(name);
    if (found?.kind === 'file') return new MemoryFile(name, found) as unknown as FileSystemFileHandle;
    if (found) throw wrongType(name); if (!options.create) throw missing(name);
    const file: FileNode = { kind: 'file', bytes: new Uint8Array(), modified: Date.now() };
    this.node.entries.set(name, file); return new MemoryFile(name, file) as unknown as FileSystemFileHandle;
  }
  async getDirectoryHandle(name: string, options: FileSystemGetDirectoryOptions = {}): Promise<FileSystemDirectoryHandle> {
    const found = this.node.entries.get(name);
    if (found?.kind === 'directory') return new MemoryDirectory(name, found) as unknown as FileSystemDirectoryHandle;
    if (found) throw wrongType(name); if (!options.create) throw missing(name);
    const directory: DirectoryNode = { kind: 'directory', entries: new Map(), modified: Date.now() };
    this.node.entries.set(name, directory); return new MemoryDirectory(name, directory) as unknown as FileSystemDirectoryHandle;
  }
  async removeEntry(name: string, options: FileSystemRemoveOptions = {}): Promise<void> {
    const found = this.node.entries.get(name); if (!found) throw missing(name);
    if (found.kind === 'directory' && found.entries.size && !options.recursive) throw exists(name);
    this.node.entries.delete(name);
  }
  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> { for (const [name, node] of this.node.entries) yield [name, (node.kind === 'file' ? new MemoryFile(name, node) : new MemoryDirectory(name, node)) as unknown as FileSystemHandle]; }
  async *values(): AsyncIterableIterator<FileSystemHandle> { for await (const [, value] of this.entries()) yield value; }
  async *keys(): AsyncIterableIterator<string> { for (const key of this.node.entries.keys()) yield key; }
}

/** In-memory File System Access double with observable root.resolve confinement. */
export class MemoryFsaRoot extends MemoryDirectory {
  resolveCalls: FileSystemHandle[] = [];
  constructor() { super('', { kind: 'directory', entries: new Map(), modified: Date.now() }); }
  async resolve(handle: FileSystemHandle): Promise<string[] | null> {
    this.resolveCalls.push(handle);
    if (handle === (this as unknown as FileSystemHandle)) return [];
    const target = (handle as unknown as { node?: Node }).node;
    if (!target) return null;
    const find = (directory: DirectoryNode, prefix: string[]): string[] | null => {
      for (const [name, child] of directory.entries) {
        if (child === target) return [...prefix, name];
        if (child.kind === 'directory') { const nested = find(child, [...prefix, name]); if (nested) return nested; }
      }
      return null;
    };
    return find(this.node, []);
  }
}
