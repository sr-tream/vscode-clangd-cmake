import * as path from 'path';

// CMake commonly reports Apple Clang as /usr/bin/cc or /usr/bin/c++.
export function resourceDirQueryArgs(compilerPath: string, platform: NodeJS.Platform,
	passForClang: boolean, passForGcc: boolean): string[] | undefined {
	const name = path.basename(compilerPath).toLowerCase().replace(/\.exe$/, '');
	const appleAlias = platform === 'darwin' && (name === 'cc' || name === 'c++');
	if (passForClang && (name.includes('clang') || appleAlias)) {
		return ['-print-resource-dir'];
	}
	if (passForClang && name.includes('zig')) {
		return ['c++', '-print-resource-dir'];
	}
	if (passForGcc && (name.includes('gcc') || name.includes('g++'))) {
		return ['-print-file-name='];
	}
	return undefined;
}
