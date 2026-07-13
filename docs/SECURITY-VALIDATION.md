# Repository security validation

Run the following before every build, commit, or deployment:

```powershell
npm run security:validate
```

The client-boundary check starts at every source module whose top-level directive is `"use client"`. It follows resolved local runtime imports, re-exports, literal dynamic imports, and literal `require` calls. Type-only imports are excluded because they are erased from browser output. A `"use server"` module is treated as a valid Server Action boundary and its dependencies are not placed in the browser graph.

The boundary check rejects:

- known privileged modules in a browser import graph;
- any module marked `server-only` in a browser import graph;
- privileged environment-variable access in browser-facing modules;
- direct or indirect re-export of a known privileged module;
- a service-role constructor or key reference reintroduced into `src/lib/supabase.ts`;
- removal of `server-only` from `src/lib/supabase-admin.ts`.

Computed dynamic import paths, package-internal dependency graphs, and runtime module loaders are outside this small static check. The Next.js production build remains the final framework-level boundary validation.

The sensitive-artifact inventory reads file metadata and Git ignore/tracking status only. It never reads contents, deletes, moves, uploads, encrypts, or modifies candidate files. Ignored local artifacts produce warnings but do not fail. A candidate fails the command only when it is Git tracked or not protected by ignore rules.

## Manual artifact handling

1. Confirm another complete and valid copy exists.
2. Move the required backup manually to encrypted private storage outside the project and OneDrive project folder.
3. Verify access controls and backup integrity.
4. Remove the project-folder copy manually only after verification.
5. Never commit or deploy Production exports, environment files, customer data, payment data, accounting data, Auth users, or private logs.

No repository security command performs cleanup automatically.
