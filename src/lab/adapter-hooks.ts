import type { LoadHook, ResolveHook } from "node:module";

type Bundle = {
  prefix: string;
  modules: Record<string, { source: string; imports: Record<string, string> }>;
};
let bundle: Bundle;

export function initialize(captured: Bundle): void {
  bundle = captured;
}

// Resolve adapter imports exclusively against the authenticated graph. Native ESM
// supplies normal bindings and cycles without rereading a potentially changed file.
export const resolve: ResolveHook = (specifier, context, next) => {
  const { parentURL } = context;
  if (parentURL?.startsWith(bundle.prefix)) {
    const module = bundle.modules[parentURL.slice(bundle.prefix.length)]!;
    if (!Object.hasOwn(module.imports, specifier)) {
      throw new Error(`Adapter import "${specifier}" is outside its captured static graph`);
    }
    return { url: bundle.prefix + module.imports[specifier], shortCircuit: true };
  }
  // When more than one adapter is loaded, the importing bundle owns this edge.
  if (parentURL?.startsWith("turntrace-local:")) return next(specifier, context);
  if (specifier.startsWith(bundle.prefix) && Object.hasOwn(bundle.modules, specifier.slice(bundle.prefix.length))) {
    return { url: specifier, shortCircuit: true };
  }
  return next(specifier, context);
};

export const load: LoadHook = (url, context, next) => {
  if (url.startsWith(bundle.prefix)) {
    const key = url.slice(bundle.prefix.length);
    if (!Object.hasOwn(bundle.modules, key)) throw new Error("Unknown adapter module");
    return { format: "module", source: bundle.modules[key]!.source, shortCircuit: true };
  }
  return next(url, context);
};
