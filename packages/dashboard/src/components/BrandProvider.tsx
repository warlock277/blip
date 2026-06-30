import { useEffect } from "react";
import type { BrandConfig } from "@blip/shared";
import { hexToHslTriple } from "@/lib/utils";

/**
 * Tints the accent palette from `brand.primaryColor` by overriding the
 * `--primary` / `--ring` / `--up` CSS variables at the document root, and sets
 * the document title. Falls back silently when no/invalid color is provided.
 */
export function useBrand(brand: BrandConfig | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    const color = brand?.primaryColor;
    const triple = color ? hexToHslTriple(color) : null;

    if (triple) {
      root.style.setProperty("--primary", triple);
      root.style.setProperty("--ring", triple);
      // Tie the healthy/up status hue to the brand so charts feel cohesive.
      root.style.setProperty("--up", triple);
    } else {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
      root.style.removeProperty("--up");
    }

    return () => {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
      root.style.removeProperty("--up");
    };
  }, [brand?.primaryColor]);

  useEffect(() => {
    const name = brand?.name?.trim();
    document.title = name ? `${name} — Status` : "Blip — Status";
  }, [brand?.name]);
}
