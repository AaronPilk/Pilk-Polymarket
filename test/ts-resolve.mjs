// Lets Node's test runner load the Worker's TypeScript the way the bundler does: a relative import
// without an extension ('./ready') resolves to the .ts file next to it, and 'cloudflare:workers' to a small stub.
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: new URL('./cf-stub.mjs', import.meta.url).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw e;
  }
}
