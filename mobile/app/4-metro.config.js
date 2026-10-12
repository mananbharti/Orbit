// Lets the app import the shared TypeScript core (written with NodeNext ".js" import suffixes) straight from ../core/src.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const coreSrc = path.resolve(__dirname, '../core/src');
config.watchFolders = [path.resolve(__dirname, '../core')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromCore = context.originModulePath.startsWith(coreSrc);
  const name = fromCore && moduleName.startsWith('.') && moduleName.endsWith('.js') ? moduleName.slice(0, -3) : moduleName;
  return (upstream ?? context.resolveRequest)(context, name, platform);
};
module.exports = config;
