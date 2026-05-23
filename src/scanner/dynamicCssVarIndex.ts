import * as vscode from "vscode";
import { describeAt } from "./declarationContext";

export type CssVarType = "static" | "runtime";

export interface CssVarOccurrence {
  readonly name: string;
  readonly value: string;
  readonly filePath: string;
  readonly line: number;
  readonly offset: number;
  readonly selector: string;
  readonly type: CssVarType;
}

export class DynamicCssVarIndex implements vscode.Disposable {
  private readonly fileOccurrences = new Map<string, CssVarOccurrence[]>();
  private readonly nameIndex = new Map<string, CssVarOccurrence[]>();
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  
  private initialScanPromise: Promise<void> | null = null;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.{css,scss,sass,less,ts,tsx,js,jsx,vue,html}");
    this.watcher.onDidCreate(uri => this.ingestFile(uri));
    this.watcher.onDidChange(uri => this.ingestFile(uri));
    this.watcher.onDidDelete(uri => this.removeFile(uri.fsPath));
  }

  async ensureReady(): Promise<void> {
    if (!this.initialScanPromise) {
      this.initialScanPromise = this.performInitialScan();
    }
    return this.initialScanPromise;
  }

  private async performInitialScan(): Promise<void> {
    const uris = await vscode.workspace.findFiles("**/*.{css,scss,sass,less,ts,tsx,js,jsx,vue,html}", "**/node_modules/**");
    for (const uri of uris) {
      await this.ingestFile(uri, false);
    }
    this.rebuildIndex();
    this._onDidChange.fire();
  }

  private async ingestFile(uri: vscode.Uri, fireEvent = true): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 2 * 1024 * 1024) return; // Skip huge files
      const buf = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(buf).toString("utf8");
      
      const occurrences = this.parseText(text, uri.fsPath);
      this.fileOccurrences.set(uri.fsPath, occurrences);
      
      if (fireEvent) {
        this.rebuildIndex();
        this._onDidChange.fire();
      }
    } catch {
      // Ignore read errors
    }
  }

  private removeFile(filePath: string): void {
    if (this.fileOccurrences.delete(filePath)) {
      this.rebuildIndex();
      this._onDidChange.fire();
    }
  }

  private rebuildIndex(): void {
    this.nameIndex.clear();
    for (const list of this.fileOccurrences.values()) {
      for (const occ of list) {
        let group = this.nameIndex.get(occ.name);
        if (!group) {
          group = [];
          this.nameIndex.set(occ.name, group);
        }
        group.push(occ);
      }
    }
  }

  lookup(name: string): readonly CssVarOccurrence[] {
    return this.nameIndex.get(name) || [];
  }

  has(name: string): boolean {
    return this.nameIndex.has(name);
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }

  private parseText(text: string, filePath: string): CssVarOccurrence[] {
    const out: CssVarOccurrence[] = [];
    const lowerPath = filePath.toLowerCase();
    const isStyle = lowerPath.endsWith(".css") || lowerPath.endsWith(".scss") || lowerPath.endsWith(".sass") || lowerPath.endsWith(".less");
    
    const lineOffsets: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lineOffsets.push(i + 1);
    }
    const getLine = (offset: number) => {
      let l = 0, r = lineOffsets.length - 1;
      while (l <= r) {
        const m = Math.floor((l + r) / 2);
        if (lineOffsets[m] <= offset) l = m + 1;
        else r = m - 1;
      }
      return l;
    };

    // 1. Static CSS declarations
    // Only in CSS-like files or Vue components
    if (isStyle || lowerPath.endsWith(".vue")) {
      const cssRegex = /(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g;
      for (const match of text.matchAll(cssRegex)) {
        const name = match[1];
        let val = match[2].trim();
        // Drop any trailing comments
        val = val.split("/*")[0].split("//")[0].trim();
        const offset = match.index ?? 0;
        const selector = describeAt(text, offset) || "(root)";
        out.push({
          name, value: val, filePath, line: getLine(offset), offset,
          selector, type: "static"
        });
      }
    }

    if (!isStyle) {
      // 2. JS/TS/React/Vue inline object styles
      const objRegex = /(?:'|")?(--[A-Za-z0-9_-]+)(?:'|")?\s*:\s*([^,}\n]+)/g;
      for (const match of text.matchAll(objRegex)) {
        const name = match[1];
        let val = match[2].trim();
        val = val.replace(/^['"](.*)['"]$/, "$1");
        const offset = match.index ?? 0;
        out.push({
          name, value: val, filePath, line: getLine(offset), offset,
          selector: "(inline style)", type: "runtime"
        });
      }

      // 3. Angular style bindings
      const ngRegex = /\[style\.(--[A-Za-z0-9_-]+)\]\s*=\s*(?:'|")([^'"]+)(?:'|")/g;
      for (const match of text.matchAll(ngRegex)) {
        const name = match[1];
        const val = match[2].trim();
        const offset = match.index ?? 0;
        out.push({
          name, value: val, filePath, line: getLine(offset), offset,
          selector: "(angular binding)", type: "runtime"
        });
      }

      // 4. JS setProperty
      const setPropRegex = /\.setProperty\(\s*(?:'|")(--[A-Za-z0-9_-]+)(?:'|")\s*,\s*([^),]+)/g;
      for (const match of text.matchAll(setPropRegex)) {
        const name = match[1];
        let val = match[2].trim();
        val = val.replace(/^['"](.*)['"]$/, "$1");
        const offset = match.index ?? 0;
        out.push({
          name, value: val, filePath, line: getLine(offset), offset,
          selector: "setProperty", type: "runtime"
        });
      }
    }

    return out;
  }
}
