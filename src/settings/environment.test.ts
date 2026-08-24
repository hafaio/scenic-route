import { expect, test } from "bun:test";

// The modules that reach for browser storage run their first read at IMPORT, so an environment they
// mishandle takes the whole bundle down rather than degrading. That is not hypothetical: a
// `typeof window === "undefined"` guard passed locally on a runtime with no window at all and threw
// in CI on one that defines a window with no `localStorage` on it, which is a failure nothing else
// here would have caught — every other test imports these modules only after something else has.
//
// So these import them under each shape by hand. `globalThis` is restored either way, because a
// leaked global would change what every test after this one sees.

async function importingUnder(
  globals: Record<string, unknown>,
  path: string,
): Promise<unknown> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  try {
    // A fresh query string each time, so the module's top-level read runs again rather than being
    // served from the loader's cache.
    return await import(`${path}?env=${Math.random()}`);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  }
}

test("the settings store survives a window with no localStorage on it", async () => {
  const store = (await importingUnder({ window: {} }, "./store")) as {
    settings: () => { layerOrder: readonly string[]; allowFerries: boolean };
  };
  expect(store.settings().layerOrder).toEqual([]);
  expect(store.settings().allowFerries).toBe(true);
});

test("the settings store survives a localStorage that throws on access", async () => {
  const hostile = {
    getItem() {
      throw new Error("storage is blocked in this context");
    },
    setItem() {
      throw new Error("storage is blocked in this context");
    },
  };
  const store = (await importingUnder(
    { window: { localStorage: hostile }, localStorage: hostile },
    "./store",
  )) as { settings: () => { layerOrder: readonly string[] } };
  expect(store.settings().layerOrder).toEqual([]);
});

test("the theme store survives a document with no documentElement", async () => {
  const theme = (await importingUnder(
    { document: {} },
    "../theme/current",
  )) as { currentTheme: () => string };
  expect(theme.currentTheme()).toBe("light");
});

test("the pre-document keys still migrate when there is no document at all", async () => {
  const held = new Map<string, string>([
    ["scenic-route:tree-weight", "0.35"],
    ["scenic-route:allow-sheds", "false"],
  ]);
  const shim = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => held.set(key, value),
  };
  const store = (await importingUnder({ localStorage: shim }, "./store")) as {
    settings: () => { weights: Record<string, number>; allowSheds: boolean };
  };
  expect(store.settings().weights.tree).toBe(0.35);
  expect(store.settings().allowSheds).toBe(false);
  // And written forward, so the next read does not have to go looking for them again.
  expect(held.get("scenic-route:settings.v1")).toContain('"tree":0.35');
});
