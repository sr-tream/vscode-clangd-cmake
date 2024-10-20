import * as vscode from 'vscode';
import * as fs from 'fs';

interface CompileFlags {
    CompilationDatabase?: string;
};

interface If {
    PathMatch?: RegExp | RegExp[];
    PathExclude?: RegExp | RegExp[];
};

interface Rule {
    If?: If;
    CompileFlags: CompileFlags;
};

enum BlockId {
    None = '',
    If = 'If:',
    CompileFlags = 'CompileFlags:',
    BlockEnd = '---'
};


export class ClangdConfig implements vscode.Disposable {
    private rules: Rule[] = [];

    /**
     * Reads a Clangd config file and parses it.
     * @param configPath the path to the config file ([`.clangd` or `clangd.yaml`](https://clangd.llvm.org/config#files))
     */
    constructor(configPath: string) {
        if (!fs.existsSync(configPath))
            throw new Error(`Clangd config file ${configPath} not found`);

        const fileContent: string = fs.readFileSync(configPath, 'utf-8');
        const lines: string[] = fileContent.split(/\r?\n/);

        // Very simple matcher. It's not follow the YAML spec.
        let currentBlock: BlockId = BlockId.None;
        let rule: Rule | undefined;
        for (let line of lines) {
            if (line.startsWith(BlockId.CompileFlags)) {
                currentBlock = BlockId.CompileFlags;
                continue;
            }
            if (line.startsWith(BlockId.If)) {
                currentBlock = BlockId.If;
                continue;
            }
            if (line.trim() === BlockId.BlockEnd) {
                if (rule !== undefined)
                    this.rules.push(rule);
                currentBlock = BlockId.None;
                rule = undefined;
                continue;
            }

            if (currentBlock === BlockId.CompileFlags) {
                if (line.match(/^\s+CompilationDatabase:.*/)) {
                    let compileDatabase: string = line.replace(/^\s+CompilationDatabase:\s*/, '');
                    if (compileDatabase.startsWith('"') || compileDatabase.startsWith('\''))
                        compileDatabase = compileDatabase.substring(1, compileDatabase.length - 1);
                    if (rule === undefined)
                        rule = { CompileFlags: { CompilationDatabase: compileDatabase } };
                    else
                        rule.CompileFlags.CompilationDatabase = compileDatabase;
                }
                continue;
            }

            if (currentBlock === BlockId.If) {
                if (line.match(/^\s+PathMatch:.*/)) {
                    const pathMatch: string = line.replace(/^\s+PathMatch:\s*/, '');
                    if (rule === undefined)
                        rule = { CompileFlags: {}, If: {} };
                    else if (rule.If === undefined)
                        rule.If = {};

                    if (pathMatch.startsWith('[')) {
                        const pathMatches = pathMatch.substring(1, pathMatch.length - 1).split(',');
                        rule.If!.PathMatch = [];
                        for (let pathMatch of pathMatches) {
                            pathMatch = pathMatch.trim();
                            rule.If!.PathMatch.push(new RegExp(pathMatch));
                        }
                    } else
                        rule.If!.PathMatch = new RegExp(pathMatch);
                    continue;
                }
                if (line.match(/^\s+PathExclude:.*/)) {
                    const pathExclude: string = line.replace(/^\s+PathExclude:\s*/, '');
                    if (rule === undefined)
                        rule = { CompileFlags: {}, If: {} };
                    else if (rule.If === undefined)
                        rule.If = {};

                    if (pathExclude.startsWith('[')) {
                        const pathExcludes = pathExclude.substring(1, pathExclude.length - 1).split(',');
                        rule.If!.PathExclude = [];
                        for (let pathExclude of pathExcludes) {
                            pathExclude = pathExclude.trim();
                            rule.If!.PathExclude.push(new RegExp(pathExclude));
                        }
                    } else
                        rule.If!.PathExclude = new RegExp(pathExclude);
                    continue;
                }
            }
        }
        if (rule !== undefined)
            this.rules.push(rule);

        // Sort rules
        const definedIfRules = this.rules.filter(rule => rule.If !== undefined);
        const undefinedIfRules = this.rules.filter(rule => rule.If === undefined);
        const undefinedIfRule = undefinedIfRules.length > 0 ? [undefinedIfRules[0]] : [];
        this.rules = [...definedIfRules, ...undefinedIfRule];
    }

    dispose() {
        this.rules = [];
    }

    /**
     * Get the compilation database for a given file path
     * @param filePath Path to source file (e.g. `src/main.cpp`)
     * @returns The directory to search for compilation database ([possible values](https://clangd.llvm.org/config#compilationdatabase))
     */
    getCompilationDatabase(filePath: string): string | undefined {
        for (const rule of this.rules) {
            if (rule.If) {
                let matched = false;
                const pathMatch = rule.If.PathMatch;
                if (Array.isArray(pathMatch)) {
                    for (const match of pathMatch) {
                        if (match.test(filePath)) {
                            matched = true;
                            break;
                        }
                    }
                } else if (pathMatch && pathMatch.test(filePath))
                    matched = true;

                if (!matched)
                    continue;

                let excluded = false;
                const pathExclude = rule.If.PathExclude;
                if (Array.isArray(pathExclude)) {
                    for (const match of pathExclude) {
                        if (match.test(filePath)) {
                            excluded = true;
                            break;
                        }
                    }
                } else if (pathExclude && pathExclude.test(filePath))
                    excluded = true;

                if (excluded)
                    continue;
            }

            return rule.CompileFlags.CompilationDatabase;
        }
        return undefined;
    }
};