"use client"

import { usePathname } from "next/navigation"

const links = [
  { href: "/", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/integrations", label: "Integrations" },
]

export function NavLinks() {
  const pathname = usePathname()
  return (
    <nav className="flex items-center gap-1">
      {links.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)
        return (
          <a
            key={link.href}
            href={link.href}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
              active
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
            }`}
          >
            {link.label}
          </a>
        )
      })}
    </nav>
  )
}
