import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { ClangdConfig } from './clangd_config_parser';

export class CompileCommands implements vscode.Disposable {
    private static configFileName = '.clangd';
    private static compileCommandsFileName = 'compile_commands.json';
    private configFileWatcher: vscode.FileSystemWatcher | undefined;
    private onCreateConfigFile: vscode.Disposable | undefined;
    private onModifyConfigFile: vscode.Disposable | undefined;
    private onDeleteConfigFile: vscode.Disposable | undefined;
    private projectPath: string | undefined;
    private compilationDatabase: string | undefined;
    private config: ClangdConfig | undefined;

    constructor(projectPath: vscode.Uri) {
        this.changeProjectPath(projectPath);
    }

    dispose() {
        this.onCreateConfigFile?.dispose();
        this.onModifyConfigFile?.dispose();
        this.onDeleteConfigFile?.dispose();
        this.configFileWatcher?.dispose();
        this.config?.dispose();
        this.config = undefined;
        this.compilationDatabase = undefined;
        this.projectPath = undefined;
    }

    changeProjectPath(projectPath: vscode.Uri) {
        this.dispose();
        this.projectPath = projectPath.fsPath;

        const configPath = path.join(this.projectPath, CompileCommands.configFileName);
        this.configFileWatcher = vscode.workspace.createFileSystemWatcher(
            configPath);

        this.onCreateConfigFile = this.configFileWatcher.onDidCreate(this.didConfigCreated, this);
        this.onModifyConfigFile = this.configFileWatcher.onDidChange(this.didConfigModified, this);
        this.onDeleteConfigFile = this.configFileWatcher.onDidDelete(this.didConfigDeleted, this);

        if (fs.existsSync(configPath))
            this.reloadConfig(configPath);
    }

    findCompileCommands(filePath: string): string | undefined {
        if (this.config !== undefined)
            this.compilationDatabase = this.config.getCompilationDatabase(filePath);

        if (this.compilationDatabase !== undefined) {
            if (this.compilationDatabase.toLowerCase() === 'none')
                return undefined;
            if (this.compilationDatabase.toLowerCase() !== 'ancestors') {
                if (this.projectPath !== undefined && !path.isAbsolute(this.compilationDatabase))
                    this.compilationDatabase = path.join(this.projectPath, this.compilationDatabase);
                return this.doFindCompileCommands(this.compilationDatabase);
            }
        }

        if (this.projectPath !== undefined)
            return this.doFindCompileCommands(this.projectPath);

        return undefined;
    }

    private doFindCompileCommands(searchPath: string): string | undefined {
        if (searchPath.endsWith(path.sep + CompileCommands.compileCommandsFileName)) {
            if (fs.existsSync(searchPath))
                return searchPath;
            return undefined;
        }

        const root = path.join(searchPath, CompileCommands.compileCommandsFileName);
        if (fs.existsSync(root))
            return root;

        const build = path.join(searchPath, 'build', CompileCommands.compileCommandsFileName);
        if (fs.existsSync(build))
            return build;

        if (this.compilationDatabase !== undefined && this.compilationDatabase.toLowerCase() === 'ancestors') {
            const parent = path.normalize(path.join(searchPath, '..'));
            if (parent !== searchPath)
                return this.doFindCompileCommands(parent);
        }

        return undefined;
    }

    private reloadConfig(path: string) {
        if (this.config !== undefined)
            this.config.dispose();
        try {
            this.config = new ClangdConfig(path);
        } catch (error) {
            this.config = undefined;
            console.warn(`[clangd-cmake] Failed to parse configuration file at ${path}: ${error}`);
        }
    }

    private async didConfigCreated(uri: vscode.Uri) {
        this.reloadConfig(uri.fsPath);
    };

    private async didConfigModified(uri: vscode.Uri) {
        this.reloadConfig(uri.fsPath);
    };

    private async didConfigDeleted(uri: vscode.Uri) {
        this.compilationDatabase = undefined;
        this.config?.dispose();
        this.config = undefined;
    };
}