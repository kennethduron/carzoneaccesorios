import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const target = resolve('src/app/pos-price-certification-local');
if (process.argv.includes('--remove')) {
  // Only the fixed fixture directory created by this script is removed.
  rmSync(target, { recursive: true, force: true });
} else {
  mkdirSync(target, { recursive: true });
  copyFileSync('scripts/fixtures/pos-authorized-price-workspace.tsx', `${target}/fixture.tsx`);
  writeFileSync(`${target}/page.tsx`, 'import { notFound } from "next/navigation"; import Certification from "./fixture"; export default function Page() { if (process.env.NODE_ENV !== "development") notFound(); return <Certification />; }\n');
  console.log('Local fixture ready: /pos-price-certification-local. Remove before building or committing.');
}
