import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const frameSource = read("src/components/admin/admin-dashboard-frame.tsx");
const logoutButtonSource = read("src/components/auth/logout-button.tsx");
const logoutRouteSource = read("src/app/auth/logout/route.ts");
const adminPageSource = read("src/app/admin/page.tsx");

assert.match(frameSource, /const \[isUserMenuOpen, setIsUserMenuOpen\] = useState\(false\)/);
assert.match(frameSource, /const userMenuRef = useRef<HTMLDivElement>\(null\)/);
assert.match(frameSource, /const userMenuButtonRef = useRef<HTMLButtonElement>\(null\)/);
assert.match(frameSource, /aria-label="Abrir menú de usuario"/);
assert.match(frameSource, /aria-haspopup="menu"/);
assert.match(frameSource, /aria-expanded=\{isUserMenuOpen\}/);
assert.match(frameSource, /aria-controls="admin-mobile-user-menu"/);
assert.match(frameSource, /size-11[\s\S]*sm:hidden/);
assert.match(frameSource, /hidden size-9[\s\S]*sm:inline-flex/);
assert.match(frameSource, /isUserMenuOpen \? \(/);
assert.match(frameSource, /id="admin-mobile-user-menu"/);
assert.match(frameSource, /role="menu"/);
assert.match(frameSource, /right-0 top-full z-50 mt-2 w-44 max-w-\[calc\(100vw-1\.5rem\)\]/);
assert.match(frameSource, /<LogoutMenuItemProvider>\{logoutSlot\}<\/LogoutMenuItemProvider>/);
assert.match(frameSource, /onSubmitCapture=\{\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => setIsUserMenuOpen\(false\)\)/);
assert.match(frameSource, /userMenuRef\.current && !userMenuRef\.current\.contains\(target\)/);
assert.match(frameSource, /event\.key === "Escape"[\s\S]*userMenuButtonRef\.current\?\.focus\(\)/);
assert.match(frameSource, /window\.matchMedia\("\(min-width: 640px\)"\)/);
assert.match(frameSource, /setSearchOpen\(false\)[\s\S]*setNotificationsOpen\(false\)[\s\S]*setDrawerOpen\(false\)/);
assert.doesNotMatch(frameSource, /<form\s+action="\/auth\/logout"/);
assert.doesNotMatch(frameSource, /supabase\.auth\.signOut/);

assert.match(logoutButtonSource, /^"use client";/);
assert.match(logoutButtonSource, /useFormStatus\(\)/);
assert.match(logoutButtonSource, /disabled=\{pending\}/);
assert.match(logoutButtonSource, /aria-disabled=\{pending\}/);
assert.match(logoutButtonSource, /role=\{isMenuItem \? "menuitem" : undefined\}/);
assert.match(logoutButtonSource, /pending \? "Cerrando sesión\.\.\." : "Cerrar sesión"/);
assert.match(logoutButtonSource, /<form action="\/auth\/logout" method="post">/);
assert.doesNotMatch(logoutButtonSource, /method="get"/i);
assert.doesNotMatch(logoutButtonSource, /supabase\.auth\.signOut/);

assert.match(logoutRouteSource, /export async function POST\(\)/);
assert.match(logoutRouteSource, /await supabase\.auth\.signOut\(\)/);
assert.match(logoutRouteSource, /redirect\("\/"\)/);
assert.doesNotMatch(logoutRouteSource, /export async function GET\(\)/);

assert.match(adminPageSource, /const isAccountant = profile\.role === "contadora"/);
assert.match(adminPageSource, /const isWarehouse = profile\.role === "bodega"/);
assert.equal((adminPageSource.match(/<LogoutButton \/>/g) ?? []).length, 3);
assert.match(adminPageSource, /logoutSlot=\{<LogoutButton \/>\}/);

console.log("Admin mobile user menu structure checks passed.", {
  mobileBreakpoint: 640,
  logoutMethod: "POST",
  logoutEndpoint: "/auth/logout",
  clientSupabaseCalls: 0,
});
