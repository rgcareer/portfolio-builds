// @rgcareer/model-regress — a paired golden-set regression detector for model/prompt
// migrations. Measures a same-model noise floor before calling anything a regression, and
// tracks cost + latency per item so a quality win can't hide a cost regression.

export * from './golden';
export * from './assertions';
export * from './estimate';
export * from './stats';
export * from './runner';
export * from './compare';
export * from './ci';
export * from './report';
export * from './protocol';
export * from './audits';
export { runCli, type CliIO, type CliPaths, type RunCliOptions } from './cli';
