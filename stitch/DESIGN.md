# Design System Strategy: The High-Roller Editorial

## 1. Overview & Creative North Star
**Creative North Star: "The Grand Horizon"**
This design system moves away from the cluttered, flashing interfaces of traditional online betting and toward the hushed, high-stakes atmosphere of a private VIP lounge. It is built on the concept of **Cinematic Noir**—where deep shadows, selective illumination, and tactile richness create an environment of prestige.

We break the "standard web template" by utilizing **Intentional Asymmetry**. Key elements should feel curated, not just placed. By overlapping high-resolution textures with sharp, modern typography and "neon-glow" accents, we create a digital experience that feels like a physical space. The layout thrives on the tension between massive, bold Serif headlines and delicate, technical Sans-Serif labels.

## 2. Colors & Atmospheric Depth
The palette is rooted in the "Midnight" spectrum, using deep obsidian tones as a canvas for "Molten Gold" and "Velvet Crimson."

*   **Primary (`#e9c349`):** Our "Molten Gold." Use this for critical actions and high-level branding. 
*   **Secondary (`#ffb4a8`):** Our "Velvet Rose." Use this to draw the eye to high-energy areas or promotional highlights.
*   **Neutral Palette:** The background (`#131313`) is the void. Hierarchy is built using the `surface-container` tokens to create "light pools" on the dark floor.

**The "No-Line" Rule**
Borders are a relic of low-fidelity design. In this system, **1px solid lines for sectioning are strictly prohibited.** Boundaries must be defined by:
*   **Background Shifts:** A `surface-container-low` section sitting against the `background` creates a sophisticated, soft-edge transition.
*   **Tonal Transitions:** Use a subtle gradient from `surface-container-low` to `surface-container-high` to guide the eye vertically.

**The "Glass & Gradient" Rule**
To capture the "Casino Neon" aesthetic, use Glassmorphism for floating overlays. Apply a `backdrop-blur` (12px–20px) to `surface-container-highest` at 60% opacity. For CTAs, apply a linear gradient from `primary` to `primary-container` at a 135-degree angle to simulate the sheen of polished metal.

## 3. Typography: Authority & Precision
Our typography pairing is a dialogue between classic luxury and modern tech.

*   **The Display Voice (`notoSerif`):** Used for `display` and `headline` scales. This represents the "Heritage" of the casino. It should be typeset with tight letter-spacing (-0.02em) to feel authoritative and dense.
*   **The Functional Voice (`manrope`):** Used for `title` and `body`. It provides a clean, neutral balance to the expressive Serif.
*   **The Technical Voice (`spaceGrotesk`):** Reserved for `label` scales. These are the "digital receipts" of the experience—odds, counts, and metadata. They should always be uppercase with increased letter-spacing (+0.05em) for a high-end, "engraved" look.

## 4. Elevation & Depth: Tonal Layering
Traditional shadows look "muddy" on dark backgrounds. We achieve depth through **Luminance Stacking.**

*   **The Layering Principle:** 
    1.  **Floor:** `surface-container-lowest` (The deepest background).
    2.  **Base Content:** `surface-container-low`.
    3.  **Interactive Cards:** `surface-container-high`.
    4.  **Floating Elements:** `surface-container-highest` with a Glassmorphism effect.
*   **Ambient Shadows:** If a floating element requires a shadow, use a `32px` blur with 8% opacity. The shadow color must be a tint of `secondary_container` (deep red) to simulate the glow of neon light reflecting off a dark surface.
*   **The "Ghost Border" Fallback:** If accessibility requires a stroke, use the `outline-variant` token at **15% opacity**. It should be felt, not seen.

## 5. Components

### Buttons: The Signature Interaction
*   **Primary:** A "Gold Foil" effect using the `primary` token. No border. Soft-edge radius (`DEFAULT`: 0.25rem). On hover, add a `primary_container` outer glow (8px blur).
*   **Secondary:** Ghost style. Transparent background with a `primary` "Ghost Border" (20% opacity). Text in `primary`.
*   **Tertiary:** `label-md` typography in `on_surface_variant`, no container.

### Cards & Lists: The Infinite Flow
*   **Forbid Dividers:** Never use lines to separate list items. Use `spacing-4` (1.4rem) of vertical white space or alternate background tiers (`surface-container-low` vs `surface-container-high`).
*   **Image Integration:** Cards should feature high-quality textures (marble, felt, or brushed metal) as subtle background overlays at 5% opacity.

### Input Fields: The Minimalist Entry
*   **State:** Default inputs use `surface-container-highest` with a bottom-only "Ghost Border."
*   **Focus State:** The bottom border transforms into a `primary` neon glow. Label moves to `label-sm` using `spaceGrotesk`.

### Signature Component: The "Neon Badge"
*   For status indicators (e.g., "Live Now"), use a `tertiary_container` background with `tertiary` text. Apply a `4px` blur of the same color behind the badge to create a "pulsing neon" effect.

## 6. Do’s and Don'ts

### Do:
*   **Do** use asymmetrical margins. For example, a hero headline might have a `spacing-16` left margin but a `spacing-8` right margin to create editorial tension.
*   **Do** use `surface-bright` for hover states on dark containers to create a "spotlight" effect.
*   **Do** prioritize high-contrast typography (e.g., `display-lg` next to `label-sm`).

### Don’t:
*   **Don’t** use pure white (`#FFFFFF`). Use `on_surface` (`#e5e2e1`) to maintain the "Midnight" atmosphere and reduce eye strain.
*   **Don’t** use "Card Shadows" on every element. Let the background color shifts do the work.
*   **Don’t** use standard icons. Use thin-stroke (1pt or 1.5pt) custom iconography that matches the `outline` token weight.