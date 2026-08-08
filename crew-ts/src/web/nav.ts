// Shared sidebar navigation for the signed-in app shell.
import type { Nav } from "./theme.js";

export function navFor(active: string, isAdmin: boolean): Nav[] {
  const items: { href: string; label: string; icon: string; key: string }[] = [
    { href: "/app", label: "Dashboard", icon: "dashboard", key: "app" },
  ];
  if (isAdmin) items.push({ href: "/admin", label: "Admin", icon: "admin", key: "admin" });
  items.push({ href: "/settings", label: "Settings", icon: "settings", key: "settings" });
  return items.map((i) => ({ href: i.href, label: i.label, icon: i.icon, active: i.key === active }));
}
