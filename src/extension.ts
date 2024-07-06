import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as path from 'path';

import * as api from 'vscode-cmake-tools';
import type { ClangdApiV1, ClangdExtension } from '@clangd/vscode-clangd';

const CLANGD_EXTENSION = 'llvm-vs-code-extensions.vscode-clangd';
const CLANGD_API_VERSION = 1;
const CLANGD_WAIT_TIME_MS = 200;

let integrationInstance: CMakeToolsIntegration | undefined;

export async function activate(context: vscode.ExtensionContext) {
	integrationInstance = new CMakeToolsIntegration();
}

export function deactivate() {
	if (integrationInstance) {
		integrationInstance.dispose();
	}
}

namespace protocol {
	interface DidChangeConfigurationClientCapabilities {
		dynamicRegistration?: boolean;
	}

	export interface ClangdCompileCommand {
		// Directory
		workingDirectory: string;
		// Command line
		compilationCommand: string[];
	}

	interface ConfigurationSettings {
		// File -> ClangdCompileCommand
		compilationDatabaseChanges: Object;
	}

	export interface DidChangeConfigurationParams {
		settings: ConfigurationSettings;
	}

	export namespace DidChangeConfigurationRequest {
		export const type = 'workspace/didChangeConfiguration';
	}
} // namespace protocol



class CMakeToolsIntegration implements vscode.Disposable {
	private projectChange: vscode.Disposable = { dispose() { } };
	private codeModelChange: vscode.Disposable | undefined;
	private cmakeTools: api.CMakeToolsApi | undefined;
	private project: api.Project | undefined;
	private codeModel: Map<string, protocol.ClangdCompileCommand> | undefined;
	private clangd: ClangdApiV1 | undefined;

	constructor() {
		let cmakeTools = api.getCMakeToolsApi(api.Version.v1);
		if (cmakeTools === undefined)
			return;

		cmakeTools.then(api => {
			this.cmakeTools = api;
			if (this.cmakeTools === undefined)
				return;

			this.projectChange = this.cmakeTools.onActiveProjectChanged(
				this.onActiveProjectChanged, this);
			if (vscode.workspace.workspaceFolders !== undefined) {
				// FIXME: clangd not supported multi-workspace projects
				const projectUri = vscode.workspace.workspaceFolders[0].uri;
				this.onActiveProjectChanged(projectUri);
			}
		});
	}
	dispose() {
		if (this.codeModelChange !== undefined)
			this.codeModelChange.dispose();
		this.projectChange.dispose();
	}

	async getClangd() {
		if (this.clangd == undefined || this.clangd.languageClient.state === vscodelc.State.Stopped) {
			const clangdExtension = vscode.extensions.getExtension<ClangdExtension>(CLANGD_EXTENSION);
			if (!clangdExtension) {
				throw new Error('Could not find clangd extension');
			}
			this.clangd = clangdExtension.exports.getApi(CLANGD_API_VERSION);
		}

		return this.clangd;
	}

	async onActiveProjectChanged(path: vscode.Uri | undefined) {
		if (this.codeModelChange !== undefined) {
			this.codeModelChange.dispose();
			this.codeModelChange = undefined;
		}

		if (path === undefined)
			return;

		this.cmakeTools?.getProject(path).then(project => {
			this.project = project;
			this.codeModelChange =
				this.project?.onCodeModelChanged(this.onCodeModelChanged, this);
			this.onCodeModelChanged();
		});
	}

	async onCodeModelChanged() {
		const content = this.project?.codeModel;
		if (content === undefined)
			return;

		if (content.toolchains === undefined)
			return;

		const request: protocol.DidChangeConfigurationParams = {
			settings: { compilationDatabaseChanges: {} }
		};

		let codeModelChanges: Map<string, protocol.ClangdCompileCommand> =
			new Map();
		content.configurations.forEach(configuration => {
			configuration.projects.forEach(project => {
				let sourceDirectory = project.sourceDirectory;
				project.targets.forEach(target => {
					if (target.sourceDirectory !== undefined)
						sourceDirectory = target.sourceDirectory;
					let commandLine: string[] = [];
					if (target.sysroot !== undefined)
						commandLine.push(`--sysroot=${target.sysroot}`);
					target.fileGroups?.forEach(fileGroup => {
						if (fileGroup.language === undefined)
							return;

						const compiler = content.toolchains?.get(fileGroup.language);
						if (compiler === undefined)
							return;

						commandLine.unshift(compiler.path);
						if (compiler.target !== undefined)
							commandLine.push(`--target=${compiler.target}`);

						let compilerName =
							compiler.path.substring(compiler.path.lastIndexOf(path.sep) + 1)
								.toLowerCase();
						if (compilerName.endsWith('.exe'))
							compilerName = compilerName.substring(0, compilerName.length - 4);

						const ClangCLMode =
							compilerName === 'cl' || compilerName === 'clang-cl';
						const incFlag = ClangCLMode ? '/I' : '-I';
						const defFlag = ClangCLMode ? '/D' : '-D';

						fileGroup.compileCommandFragments?.forEach(commands => {
							commands.split(/\s/g).forEach(
								command => { commandLine.push(command); });
						});
						fileGroup.includePath?.forEach(
							include => { commandLine.push(`${incFlag}${include.path}`); });
						fileGroup.defines?.forEach(
							define => { commandLine.push(`${defFlag}${define}`); });
						fileGroup.sources.forEach(source => {
							const file = sourceDirectory.length != 0
								? sourceDirectory + path.sep + source
								: source;
							const command: protocol.ClangdCompileCommand = {
								workingDirectory: sourceDirectory,
								compilationCommand: commandLine
							};
							codeModelChanges.set(file, command);
						});
					});
				});
			});
		});

		const codeModel = new Map(codeModelChanges);
		this.codeModel?.forEach((cc, file) => {
			if (!codeModelChanges.has(file)) {
				const command: protocol.ClangdCompileCommand = {
					workingDirectory: '',
					compilationCommand: []
				};
				codeModelChanges.set(file, command);
				return;
			}
			const command = codeModelChanges.get(file);
			if (command?.workingDirectory === cc.workingDirectory &&
				command?.compilationCommand.length === cc.compilationCommand.length &&
				command?.compilationCommand.every(
					(val, index) => val === cc.compilationCommand[index])) {
				codeModelChanges.delete(file);
			}
		});
		this.codeModel = codeModel;

		if (codeModelChanges.size === 0)
			return;

		codeModelChanges.forEach(
			(cc, file) => {
				Object.assign(
					request.settings.compilationDatabaseChanges, { [file]: cc })
			});

		const lc = (await this.getClangd()).languageClient;
		const interval = setInterval(function (This: CMakeToolsIntegration) {
			if (lc.state !== vscodelc.State.Running) return;

			lc.sendNotification(
				protocol.DidChangeConfigurationRequest.type, request);
			clearInterval(interval);
		}, CLANGD_WAIT_TIME_MS, this);
	}
}