globalThis.process ??= {};
globalThis.process.env ??= {};
import { c as createComponent } from "./astro-component_CNxeu-8U.mjs";
import { V as renderTemplate, C as maybeRenderHead } from "./runtime_MGgYZpWf.mjs";
import { r as renderComponent } from "./worker-entry_DyCfPpaT.mjs";
import { $ as $$Layout } from "./Layout_BPiHyacv.mjs";
const $$Dashboard = createComponent(($$result, $$props, $$slots) => {
  const Astro2 = $$result.createAstro($$props, $$slots);
  Astro2.self = $$Dashboard;
  const { user } = Astro2.locals;
  return renderTemplate`${renderComponent($$result, "Layout", $$Layout, { "title": "Dashboard" }, { "default": ($$result2) => renderTemplate` ${maybeRenderHead()}<div class="bg-cosmic flex min-h-screen items-center justify-center p-4"> <div class="rounded-2xl border border-white/10 bg-white/10 p-8 text-center text-white backdrop-blur-xl"> <h1 class="mb-4 bg-gradient-to-r from-blue-200 to-purple-200 bg-clip-text text-3xl font-bold text-transparent">
Dashboard
</h1> <p class="text-blue-100/80">
Welcome, <span class="font-semibold text-white">${user?.email}</span> </p> <p class="mt-2 text-sm text-blue-100/50">This page is only for authenticated users.</p> <form method="POST" action="/api/auth/signout" class="mt-6"> <button type="submit" class="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm transition-colors hover:bg-white/20">
Sign out
</button> </form> </div> </div> ` })}`;
}, "C:/Users/krzysztof.zacha/repo/gain-pace/src/pages/dashboard.astro", void 0);
const $$file = "C:/Users/krzysztof.zacha/repo/gain-pace/src/pages/dashboard.astro";
const $$url = "/dashboard";
const _page = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: $$Dashboard,
  file: $$file,
  url: $$url
}, Symbol.toStringTag, { value: "Module" }));
const page = () => _page;
export {
  page
};
