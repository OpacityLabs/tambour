# Naming — the post-`$` convention

Tambour dropped the `$`-suffix convention for reactive nodes (2026-07-21).
This doc states the convention that replaced it, the API changes that came
with it, and the mechanical recipe for migrating a consuming codebase.

## The rule

> **Nouns are state, verbs are actions.**
> A noun exported from a state module is a reactive node — read it with
> `useValue` in components, `.get()`/`.peek()` in handlers, or pass it to
> `selector`/`reaction`/`update` scopes. A verb is a function you call.
> A noun that takes arguments (`todoById(id)`, `libraryBooks(q)`) returns
> reactive state. `$` means exactly one thing: a raw RxJS observable.

That's the whole convention. Concretely:

| Thing | Grammar | Example |
|---|---|---|
| atom | noun | `export const cart = atom('cart', {...})` |
| selector / streamSelector | noun phrase naming the derivation | `visibleBooks`, `debouncedQuery` |
| selectorFamily / query family | parameterized noun | `todoById`, `libraryBooks` |
| update | imperative verb | `addItem`, `resetShare` |
| event / mutation | imperative verb | `submitVerification`, `donate` |
| event status | the `.status` node on the event itself | `useValue(donate.status.pending)` |
| `useValue` result | plain noun for the snapshot's role | `const books = useValue(visibleBooks)` |
| RxJS observable | noun + `$` | `const query$ = atomToStream(searchUi.query).pipe(...)` |

The file conventions carry the rest of the signal: `.atom.ts` and
`.selectors.ts` files export nouns (nodes); `.updates.ts` and `.events.ts`
files export verbs (commands). See SPEC.md "File conventions".

## Why the `$` left

- **It encoded mechanism, not meaning.** `$` asked the author to classify the
  runtime kind of a binding (node vs snapshot), with unwritten exceptions for
  factories and accessors. In the opacity-app audit, every mechanical
  application of the rule held and every judgment call drifted — the only
  violations in ~30 identifiers were bound `statusOf(...)` results. Under the
  noun/verb rule those bindings are correct by construction.
- **`use$` broke the React Compiler.** Hook detection (compiler and
  eslint-plugin-react-hooks) requires `/^use[A-Z0-9]/`; `$` fails it, so
  compiled components memoized AROUND the hook and crashed with hook-order
  errors on-device. Every migrated opacity screen hit this.
- **Consumption is already marked.** Every node read goes through
  `useValue`/`.get()`/`.peek()` or a tambour primitive — the access idiom and
  the `ReadonlyNode` types carry the signal a suffix duplicated.
- **The ecosystem meaning of `$` is "Rx stream".** Reserving it for actual
  RxJS observables (streamSelector pipelines, `atomToStream`/`eventToStream`
  results) makes the suffix informative again instead of overloaded.

## API changes that shipped with the convention

1. **`use$` is gone.** Import `useValue` from `tambour/react` — same
   function, compiler-safe name. Any `/^use[A-Z0-9]/` alias also works.
2. **Every command event now carries `.status`** (previously mutations only):
   `save.status` is a `ReadonlyNode<EventStatus>` — the same node
   `statusOf(save)` returns. Read it inline (`useValue(save.status.pending)`)
   or compose it (`selector(a.status, b.status, (sa, sb) => sa.pending || sb.pending)`).
3. **`statusOf` is deprecated** (still exported, returns `ev.status`).
   Migrate call sites to the property; don't bind the node to a local unless
   you're composing it.

## Migration recipe for a consuming codebase

Proven on opacity-app (~30 identifiers, 66 files, an afternoon). All
mechanical; the type checker verifies every step.

1. **Inventory.** List the distinct `$` identifiers:

   ```sh
   grep -rhoE '[A-Za-z_][A-Za-z0-9_]*\$' src --include='*.ts' --include='*.tsx' \
     | sort -u
   ```

   Audit the list for false positives before touching anything: template
   literals are safe by construction (see the pattern below), but literal `$`
   inside test strings/fixtures is not (opacity had an MRZ fixture ending in
   `1$`). Exclude those files or fix them up after.

2. **Rename `use$` call sites first** (so the generic strip can't turn them
   into `use`): `s/\buse\$/useValue/g` — then fix the imports.

3. **Strip the suffix.** For each file:

   ```sh
   perl -i -pe 's/\buse\$/useValue/g; s/([A-Za-z0-9_])\$(?!\{)/$1/g' <files>
   ```

   The `(?!\{)` guard keeps `${...}` template interpolations intact.

4. **Let the compiler find the collisions.** `tsc --noEmit` flags every place
   a stripped name now shadows the local holding its snapshot
   (`const results = useValue(results)` → TS2448/TS7022). Fix each by
   renaming ONE side for meaning: the export names the derivation
   (`searchResults`), the local names the role (`results`). Expect a handful
   per project, all in components that read a whole selector.

5. **Migrate `statusOf`.** Replace `statusOf(ev)` with `ev.status`; where the
   result was bound to a local just to read one field, inline it
   (`useValue(ev.status.pending)`).

6. **Re-point any `$`-suffixed Rx pipeline variables** — those KEEP the `$`.
   If a swept name now holds an `Observable`, restore its suffix.

7. **Verify**: typecheck, unit tests, and one on-device/browser smoke of the
   heaviest screen. Nothing here changes runtime behavior except the
   (additive) `.status` property, but the smoke test is cheap insurance.

## Lint enforcement (planned)

`ReadonlyNode`/`Atom` types make the convention mechanically checkable:

- error when an identifier of node type ends in `$`;
- error when an identifier of `Observable` type lacks the `$` suffix;
- (already enforced by React tooling) hooks match `/^use[A-Z0-9]/`.

Until the rules exist, review for the grammar: a verb-named export from a
`.atom.ts`/`.selectors.ts` file, or a noun-named export from `.updates.ts`/
`.events.ts`, is almost always a misplaced declaration.
