const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { resourceDirQueryArgs } = require('../out/resource_dir');

function integration(initialArgs, query) {
  let args = initialArgs;
  let writes = 0;
  const config = {
    get: (key, fallback) => key === 'arguments' ? args :
      key === 'resourceDir.passForClangToolchains' ? true : fallback,
    update: async (key, value) => { assert.equal(key, 'arguments'); args = value; writes++; }
  };
  const realRequire = createRequire(path.resolve('out/extension.js'));
  const context = {
    exports: {}, process, setTimeout, setInterval, clearInterval,
    require: name => {
      if (name === 'vscode') return { workspace: { getConfiguration: () => config }, ConfigurationTarget: { Workspace: 2 } };
      if (name === 'vscode-languageclient/node' || name === './compile_commands') return {};
      if (name === 'child_process' && query) return { execFile: query };
      return realRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync('out/extension.js', 'utf8') + '\nexports.Integration = CMakeToolsIntegration;', context);
  const instance = Object.create(context.exports.Integration.prototype);
  instance.clangResourceDir = '';
  instance.restartingRequests = 0;
  instance.restartingReady = 0;
  return { instance, args: () => args, writes: () => writes, reset: value => { args = value; } };
}

test('macOS cc and c++ query Apple Clang resource directory', () => {
  for (const compiler of ['/usr/bin/cc', '/usr/bin/c++', '/Xcode With Spaces/usr/bin/clang++']) {
    assert.deepEqual(resourceDirQueryArgs(compiler, 'darwin', true, false), ['-print-resource-dir']);
  }
});

test('macOS aliases respect the opt-in and are not applied on Linux', () => {
  assert.equal(resourceDirQueryArgs('/usr/bin/cc', 'darwin', false, true), undefined);
  assert.equal(resourceDirQueryArgs('/usr/bin/c++', 'linux', true, false), undefined);
});

test('Clang, GCC and Zig retain their separate settings and arguments', () => {
  assert.deepEqual(resourceDirQueryArgs('/ndk/bin/aarch64-linux-android-clang++', 'linux', true, false), ['-print-resource-dir']);
  assert.deepEqual(resourceDirQueryArgs('/usr/bin/g++', 'linux', false, true), ['-print-file-name=']);
  assert.equal(resourceDirQueryArgs('/usr/bin/g++', 'linux', true, false), undefined);
  assert.deepEqual(resourceDirQueryArgs('/tools/zig', 'linux', true, false), ['c++', '-print-resource-dir']);
});

test('startup removes an old Linux override even when cached directory is empty', async () => {
  const state = integration(['--background-index', '--resource-dir=/old/linux/clang/17']);
  await state.instance.updateResourceDir();
  assert.deepEqual(Array.from(state.args()), ['--background-index']);
  assert.equal(state.writes(), 1);
  assert.equal(state.instance.restartingReady, 1);
});

test('unchanged directory avoids restarts but externally changed arguments are repaired', async () => {
  const state = integration(['--resource-dir=/mac/clang']);
  await state.instance.updateResourceDir('/mac/clang');
  assert.equal(state.writes(), 0);
  state.reset(['--background-index', '--resource-dir=/stale']);
  await state.instance.updateResourceDir('/mac/clang');
  assert.deepEqual(Array.from(state.args()), ['--background-index', '--resource-dir=/mac/clang']);
  assert.equal(state.writes(), 1);
});

test('query failure removes a stale override', async () => {
  const state = integration(['--resource-dir=/old/linux'], (file, args, options, callback) => callback(new Error('compiler failed'), ''));
  state.instance.project = { codeModel: { toolchains: new Map([['CXX', { path: '/tools/clang++' }]]) } };
  state.instance.compileArgsFrom = 'filesystem';
  await state.instance.onCodeModelChanged();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(Array.from(state.args()), []);
});

test('invalid compiler output is not persisted', async () => {
  const state = integration(['--resource-dir=/old/linux'], (file, args, options, callback) => callback(null, 'missing-resource-dir\n'));
  state.instance.project = { codeModel: { toolchains: new Map([['CXX', { path: '/tools/clang++' }]]) } };
  state.instance.compileArgsFrom = 'filesystem';
  await state.instance.onCodeModelChanged();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(Array.from(state.args()), []);
});

test('compiler paths with spaces are passed as a file, not shell code', async () => {
  const state = integration([], (file, args, options, callback) => {
    assert.equal(file, '/tools with spaces/clang++');
    assert.deepEqual(Array.from(args), ['-print-resource-dir']);
    callback(new Error('test compiler'), '');
  });
  state.instance.project = { codeModel: { toolchains: new Map([['CXX', { path: '/tools with spaces/clang++' }]]) } };
  state.instance.compileArgsFrom = 'filesystem';
  await state.instance.onCodeModelChanged();
});

test('real Apple cc/c++ produce an existing resource directory', { skip: process.platform !== 'darwin' }, () => {
  for (const compiler of ['/usr/bin/cc', '/usr/bin/c++']) {
    const args = resourceDirQueryArgs(compiler, process.platform, true, false);
    const dir = execFileSync(compiler, args, { encoding: 'utf8' }).trim();
    assert.ok(path.isAbsolute(dir));
    assert.ok(fs.existsSync(path.join(dir, 'include', 'stdarg.h')));
  }
});


test('valid native resource directory replaces the Linux override', { skip: process.platform !== 'darwin' }, async () => {
  const dir = execFileSync('/usr/bin/cc', ['-print-resource-dir'], { encoding: 'utf8' }).trim();
  const state = integration(['--background-index', '--resource-dir=/old/linux'], (file, args, options, callback) => callback(null, dir + '\n'));
  state.instance.project = { codeModel: { toolchains: new Map([['C', { path: '/usr/bin/cc' }]]) } };
  state.instance.compileArgsFrom = 'filesystem';
  await state.instance.onCodeModelChanged();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(Array.from(state.args()), ['--background-index', '--resource-dir=' + dir]);
});
