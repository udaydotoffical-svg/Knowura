/* Dot avatar maker: the catalog and the character state, entirely in the browser.
 *
 * PROVENANCE. Our own catalog. Every id, name, finish hint, look combination and description
 * phrase in this file was written for siter.io's dot avatar maker (build spec of 2026-10-01,
 * sections 4.1, 5 and 8, the round-two spec of the same day, section 2, and the owner's changes
 * of that day: two genders, and 24 preset colors). Nothing here was taken from another avatar
 * maker. The ids are binding: share links, the studio, the thumbnails, the WebMCP tools and the
 * agent skill docs all carry them, and a link whose id disappears quietly falls back to the
 * default.
 *
 * WHAT IT IS. Pure data plus pure functions over one plain state object. No imports, no THREE,
 * no DOM, no storage and no network, so the same file runs in the page, in a module worker, in
 * the offline 3D file and in Node, where its tests run. studio.js loads it with
 * import('./catalog.js' + V) like every sibling (cache-busting contract, spec 0.6). The small
 * OKLab color math at the bottom, used only by random(), is a private copy for the same reason:
 * modules never import each other, and color.js carries the color picker's own version.
 *
 * WHAT IS IN IT. 44 shapes in 4 groups (17 classic, 18 animals, 6 fantasy, 3 food and plants),
 * 24 preset colors in four rows of six (any hex works too), 14 finishes in 3 groups, 29 hats, 11
 * glasses and 17 extras (each list counts its "none"), 10 faces, 8 mouths, 2 genders (Boy, the
 * default, and Girl), and 50 looks in 3 audience groups (7 boy, 11 girl, 32 for everyone).
 *
 * THE STATE. {shape, color, finish, gender, hat, glasses, extra, face, mouth, blush, lashes}, in
 * that order, which is also the query string's order. After normalize() every field is present:
 * color is 6 lowercase hex digits without '#', whether it came from a preset or was typed,
 * gender is 'boy' or 'girl', and blush and lashes are booleans. The look is NOT stored: lookOf()
 * derives it from the six look slots (hat glasses extra face mouth blush), and a state whose six
 * slots match no LOOK is "Custom" (null).
 *
 * TEN THINGS THAT ARE EASY TO GET WRONG, and are handled below:
 *  1. normalize() NEVER THROWS AND NEVER MUTATES. An unrecognized value falls back to the
 *     default for that one field, not to the default character, so a link with one typo still
 *     opens the right shape and color. Null, an empty string or a missing key mean "not given".
 *     validate() is the same pass with a report: invalid lists known keys whose values were not
 *     understood, each with an expected text naming what is accepted (for WebMCP errors), and
 *     unknown lists keys this catalog does not have.
 *  2. A LOOK IN THE INPUT IS A BASE, NOT AN OVERRIDE. normalize({look:'royal', hat:'none'}) is
 *     Royal without the crown, because explicit slots win; that is the order the WebMCP tool
 *     promises ("the look is applied first, then explicit slots"). To switch the look of an
 *     existing state use applyLook(): normalize({...state, look}) changes nothing, because the
 *     state's own six slots win over the look it names.
 *  3. ONE CHARACTER, ONE LINK. toQuery() omits every field equal to its default, never writes
 *     look, always writes the keys in the same order and writes color as hex (never a preset
 *     id), so fromQuery(toQuery(s)) deep-equals normalize(s) and two equal characters share one
 *     URL. The default of lashes is the gender's (rule 8), so ?gender=girl alone means lashes on,
 *     and a link without gender (every link made before genders existed) opens as a boy without
 *     lashes, exactly the character it showed then.
 *  4. NEVER THE HASH. js/slides.min.js drives the slides from the URL hash, so state lives in
 *     the query string only; fromQuery() ignores anything after '#'.
 *  5. UNKNOWN QUERY KEYS ARE NOT ERRORS. Shared links collect utm_*, ref and click ids. They go
 *     to validate().unknown, never to invalid, so the page warns only about values it could not
 *     read ("Some link settings were not recognized and were reset.").
 *  6. NAMES WORK AS WELL AS IDS. Agents and people type "Top hat", "top-hat", "Girl" or "Short
 *     plush". Matching ignores case, spaces and punctuation and accepts an option's id or its
 *     name; the output is always the id. A color is a preset id or name, or hex with 3 or 6
 *     digits, with or without '#', in any case. Numbers are never colors: 123456 could mean
 *     anything.
 *  7. THE DATA IS FROZEN. The studio, the UI, the thumbnail queue and WebMCP share these arrays;
 *     one consumer sorting or annotating them would change them for all the others. Every data
 *     export, and every group looksFor() returns, is deep-frozen, so a write throws in module
 *     code. Copy before changing. (States and genderDefaults() results are fresh plain objects.)
 *  8. LASHES FOLLOW THE GENDER UNLESS GIVEN. The lashes default is on for girl and off for boy.
 *     normalize() uses it when lashes is missing, null, '' or unreadable; an explicit value always
 *     wins. So a complete state keeps its lashes whatever else changes, and changing the gender of
 *     a state is NOT {...state, gender}: the state's own lashes would win. Use switchGender().
 *     A gender that is not boy or girl falls back to boy, the default, and validate() reports it.
 *  9. GENDER CHOOSES WHICH LOOKS COME FIRST, NEVER WHAT ANYONE MAY WEAR. Looks carry six slots
 *     and an audience ('boy', 'girl' or 'all'); lashes left the looks, so applyLook() and
 *     lookOf() ignore lashes and gender, and a boy wearing the Princess slots is Princess.
 *     looksFor(gender) returns all 50 looks for either gender, in three groups: that gender's
 *     own, everyone's, then the other gender's. Hats, glasses, extras, faces and mouths are never
 *     filtered, and normalize() never swaps a look because of the gender.
 * 10. switchGender() SWAPS ONLY A LOOK THAT HAS A COUNTERPART. It sets the gender and the new
 *     gender's lashes default. When the current look is meant for the other gender AND has a
 *     counterpart in LOOK_COUNTERPARTS (dapper and lady, royal and princess, wizard and witch),
 *     it applies the counterpart and reports swapped = {from, to} for the status line. Every
 *     other look stays as it is, since both grids show every look, and so does a custom state.
 *
 * DECISIONS WHERE THE SPEC IS SILENT.
 *  - switchGender() to the gender the state already has changes nothing (swapped null).
 *    Otherwise clicking the selected radio again would quietly turn lashes back on or off.
 *  - switchGender() with an unrecognized gender leaves the state as it was (normalized), the
 *    way applyLook() treats an unknown look; looksFor() and genderDefaults() read it as boy.
 *  - describe() reads the shape "Tiny ears" as "tiny-eared dot" (so the sentence keeps a noun)
 *    and keeps the capital of "Viking".
 *  - The round-one deviation (DEFAULTS.blush true, so the default character is exactly Cozy) is
 *    now the spec itself: round two's DEFAULTS are "Cozy exactly".
 *
 * THE PRESET COLORS. The first twelve keep their ids, names and hexes: links carry the hex, so
 * an old link must keep showing the same name. The twelve added on 2026-10-01 started from the
 * owner's hexes and were checked in OKLCH: the vivid ones sit at the set's chroma (as far as sRGB
 * allows at their lightness), the whites, tans and grays stay low. No two presets are closer in
 * OKLab than 0.089, the gap the first twelve already had (grape and ocean), except snow and
 * cream at 0.05: cream is fixed, and even pure white would only reach 0.055. Peach, sand and
 * snow moved from their starting hexes for that, and silver by one step of green.
 *
 * random(rng, opts) keeps opts.gender (default boy; names work, anything else is boy) and sets
 * lashes to that gender's default. The shape is uniform over all 44; the look is uniform over
 * that gender's own looks plus everyone's (39 for boy, 43 for girl), never the other gender's.
 * Short plush comes 40% of the time and the rest spreads evenly over the other thirteen finishes.
 * The color is a uniform pick of the 24 presets, or with probability 0.25 a generated custom
 * color: OKLCH lightness 0.723-0.897 (8-bit rounding moves L by up to about 0.0015, so the hex
 * always lands inside the 0.72-0.9 band), any hue, and a chroma of 55-90% of the most vivid
 * in-gamut chroma at that lightness and hue, rounded to the nearest hex. It always consumes
 * exactly NINE rng() values, in this order: shape, color roll, preset, lightness, chroma, hue,
 * finish roll, finish pick, look. The three custom-color values are drawn even when a preset
 * wins, so one seed always gives the same character and later draws stay in step.
 */

/* ---------------------------------------------------------------- data */

export const VERSION = 1;

export const STEPS = deepFreeze([
  { id: 'shape', name: 'Shape' },
  { id: 'color', name: 'Color' },
  { id: 'finish', name: 'Finish' },
  { id: 'look', name: 'Look' }
]);

export const SHAPE_GROUPS = deepFreeze([
  { id: 'classic', name: 'Classic' },
  { id: 'animals', name: 'Animals' },
  { id: 'fantasy', name: 'Fantasy' },
  { id: 'treats', name: 'Food and plants' }
]);

export const SHAPES = deepFreeze([
  { id: 'round', name: 'Round', group: 'classic' },
  { id: 'bean', name: 'Bean', group: 'classic' },
  { id: 'pill', name: 'Pill', group: 'classic' },
  { id: 'cushion', name: 'Cushion', group: 'classic' },
  { id: 'triangle', name: 'Triangle', group: 'classic' },
  { id: 'heart', name: 'Heart', group: 'classic' },
  { id: 'star', name: 'Star', group: 'classic' },
  { id: 'cloud', name: 'Cloud', group: 'classic' },
  { id: 'flower', name: 'Flower', group: 'classic' },
  { id: 'drop', name: 'Drop', group: 'classic' },
  { id: 'gem', name: 'Gem', group: 'classic' },
  { id: 'ears', name: 'Tiny ears', group: 'classic' },
  { id: 'butterfly', name: 'Butterfly', group: 'classic' },
  { id: 'sprout', name: 'Sprout', group: 'classic' },
  { id: 'scallop', name: 'Scallop', group: 'classic' },
  { id: 'hexagon', name: 'Hexagon', group: 'classic' },
  { id: 'diamond', name: 'Diamond', group: 'classic' },
  { id: 'bunny', name: 'Bunny', group: 'animals' },
  { id: 'cat', name: 'Cat', group: 'animals' },
  { id: 'bear', name: 'Bear', group: 'animals' },
  { id: 'panda', name: 'Panda', group: 'animals' },
  { id: 'fox', name: 'Fox', group: 'animals' },
  { id: 'pup', name: 'Pup', group: 'animals' },
  { id: 'frog', name: 'Frog', group: 'animals' },
  { id: 'penguin', name: 'Penguin', group: 'animals' },
  { id: 'chick', name: 'Chick', group: 'animals' },
  { id: 'mouse', name: 'Mouse', group: 'animals' },
  { id: 'pig', name: 'Pig', group: 'animals' },
  { id: 'owl', name: 'Owl', group: 'animals' },
  { id: 'hamster', name: 'Hamster', group: 'animals' },
  { id: 'octopus', name: 'Octopus', group: 'animals' },
  { id: 'shiba', name: 'Shiba', group: 'animals' },
  { id: 'koala', name: 'Koala', group: 'animals' },
  { id: 'axolotl', name: 'Axolotl', group: 'animals' },
  { id: 'capybara', name: 'Capybara', group: 'animals' },
  { id: 'ghost', name: 'Ghost', group: 'fantasy' },
  { id: 'dino', name: 'Dino', group: 'fantasy' },
  { id: 'robot', name: 'Robot', group: 'fantasy' },
  { id: 'alien', name: 'Alien', group: 'fantasy' },
  { id: 'unicorn', name: 'Unicorn', group: 'fantasy' },
  { id: 'monster', name: 'Monster', group: 'fantasy' },
  { id: 'mushroom', name: 'Mushroom', group: 'treats' },
  { id: 'strawberry', name: 'Strawberry', group: 'treats' },
  { id: 'cactus', name: 'Cactus', group: 'treats' }
]);

// 24 presets in display order, read as four rows of six on a wide screen: warm colors; pinks,
// purples and blues; greens and browns; whites, tans and grays from light to dark. Butter comes
// first and is the default. See THE PRESET COLORS in the header for how the new ones were set.
export const COLORS = deepFreeze([
  { id: 'butter', name: 'Butter', hex: 'ffd34e' },
  { id: 'tangerine', name: 'Tangerine', hex: 'ff9b42' },
  { id: 'peach', name: 'Peach', hex: 'fdb19a' },
  { id: 'coral', name: 'Coral', hex: 'ff6f61' },
  { id: 'cherry', name: 'Cherry', hex: 'd8384a' },
  { id: 'berry', name: 'Berry', hex: 'c2357f' },
  { id: 'bubblegum', name: 'Bubblegum', hex: 'ff8cc6' },
  { id: 'lilac', name: 'Lilac', hex: 'b79cff' },
  { id: 'grape', name: 'Grape', hex: '7b5cff' },
  { id: 'navy', name: 'Navy', hex: '2b3d8f' },
  { id: 'ocean', name: 'Ocean', hex: '2f6bff' },
  { id: 'sky', name: 'Sky', hex: '5ab8ff' },
  { id: 'teal', name: 'Teal', hex: '1f9e98' },
  { id: 'mint', name: 'Mint', hex: '3fd0a4' },
  { id: 'lime', name: 'Lime', hex: 'b6e05a' },
  { id: 'moss', name: 'Moss', hex: '7fb241' },
  { id: 'caramel', name: 'Caramel', hex: 'c88a52' },
  { id: 'cocoa', name: 'Cocoa', hex: '6b4531' },
  { id: 'snow', name: 'Snow', hex: 'fcfdff' },
  { id: 'cream', name: 'Cream', hex: 'f3ede1' },
  { id: 'sand', name: 'Sand', hex: 'e3d4a4' },
  { id: 'silver', name: 'Silver', hex: 'c2c7d1' },
  { id: 'slate', name: 'Slate', hex: '5d6676' },
  { id: 'ink', name: 'Ink', hex: '2a2a30' }
]);

export const FINISH_GROUPS = deepFreeze([
  { id: 'soft', name: 'Soft' },
  { id: 'glaze', name: 'Glazed and matte' },
  { id: 'clear', name: 'Shiny and clear' }
]);

// hint: 3-6 words for a tooltip, describing what the finish does to the surface.
export const FINISHES = deepFreeze([
  { id: 'plush', name: 'Short plush', group: 'soft', hint: 'Short velvet fur with sheen' },
  { id: 'fluffy', name: 'Fluffy', group: 'soft', hint: 'Long shaggy fur that sways' },
  { id: 'felt', name: 'Felt', group: 'soft', hint: 'Matted wool fuzz, fully matte' },
  { id: 'clay', name: 'Clay', group: 'soft', hint: 'Satin matte with handmade marks' },
  { id: 'ceramic', name: 'Glazed ceramic', group: 'glaze', hint: 'Glossy glaze, deeper in hollows' },
  { id: 'crackle', name: 'Crackle glaze', group: 'glaze', hint: 'Glossy glaze with fine cracks' },
  { id: 'speckled', name: 'Speckled stoneware', group: 'glaze', hint: 'Rough matte stone, dark flecks' },
  { id: 'pearl', name: 'Pearl', group: 'glaze', hint: 'Pale gloss with rainbow shimmer' },
  { id: 'rubber', name: 'Soft rubber', group: 'glaze', hint: 'Soft-touch matte, faint sheen' },
  { id: 'vinyl', name: 'Vinyl toy', group: 'clear', hint: 'Semi-gloss like a toy figure' },
  { id: 'glitter', name: 'Glitter', group: 'clear', hint: 'Clear coat over sparkling flakes' },
  { id: 'jelly', name: 'Jelly', group: 'clear', hint: 'See-through, tinted deeper inside' },
  { id: 'glass', name: 'Glass', group: 'clear', hint: 'Clear with a light tint' },
  { id: 'chrome', name: 'Chrome', group: 'clear', hint: 'Mirror metal tinted by color' }
]);

export const HATS = deepFreeze([
  { id: 'none', name: 'No hat' },
  { id: 'beanie', name: 'Beanie' },
  { id: 'cap', name: 'Cap' },
  { id: 'tophat', name: 'Top hat' },
  { id: 'crown', name: 'Crown' },
  { id: 'tiara', name: 'Tiara' },
  { id: 'wizard', name: 'Wizard hat' },
  { id: 'beret', name: 'Beret' },
  { id: 'party', name: 'Party hat' },
  { id: 'chef', name: 'Chef hat' },
  { id: 'bucket', name: 'Bucket hat' },
  { id: 'cowboy', name: 'Cowboy hat' },
  { id: 'sunhat', name: 'Sun hat' },
  { id: 'flowers', name: 'Flower crown' },
  { id: 'halo', name: 'Halo' },
  { id: 'bow', name: 'Hair bow' },
  { id: 'pillbox', name: 'Pillbox hat' },
  { id: 'pirate', name: 'Pirate hat' },
  { id: 'detective', name: 'Detective cap' },
  { id: 'ninja', name: 'Ninja band' },
  { id: 'witch', name: 'Witch hat' },
  { id: 'nightcap', name: 'Nightcap' },
  { id: 'sweatband', name: 'Sweatband' },
  { id: 'boppers', name: 'Space boppers' },
  { id: 'moon', name: 'Moon and star' },
  { id: 'viking', name: 'Viking helmet' },
  { id: 'catears', name: 'Cat ears' },
  { id: 'grad', name: 'Grad cap' },
  { id: 'propeller', name: 'Propeller cap' }
]);

export const GLASSES = deepFreeze([
  { id: 'none', name: 'No glasses' },
  { id: 'round', name: 'Round glasses' },
  { id: 'square', name: 'Square glasses' },
  { id: 'sunnies', name: 'Sunglasses' },
  { id: 'hearts', name: 'Heart glasses' },
  { id: 'stars', name: 'Star glasses' },
  { id: 'monocle', name: 'Monocle' },
  { id: 'visor', name: 'Visor' },
  { id: 'eyepatch', name: 'Eye patch' },
  { id: 'cateye', name: 'Cat-eye glasses' },
  { id: 'goggles', name: 'Goggles' }
]);

export const EXTRAS = deepFreeze([
  { id: 'none', name: 'No extra' },
  { id: 'bowtie', name: 'Bow tie' },
  { id: 'scarf', name: 'Scarf' },
  { id: 'headphones', name: 'Headphones' },
  { id: 'pearls', name: 'Pearl necklace' },
  { id: 'bandana', name: 'Bandana' },
  { id: 'bell', name: 'Bell collar' },
  { id: 'backpack', name: 'Backpack' },
  { id: 'flower', name: 'Flower clip' },
  { id: 'sprout', name: 'Sprout' },
  { id: 'headset', name: 'Gaming headset' },
  { id: 'catphones', name: 'Cat headphones' },
  { id: 'heartclip', name: 'Heart clip' },
  { id: 'cape', name: 'Cape' },
  { id: 'wings', name: 'Wings' },
  { id: 'necktie', name: 'Necktie' },
  { id: 'medal', name: 'Medal' }
]);

export const FACES = deepFreeze([
  { id: 'dot', name: 'Dot eyes' },
  { id: 'happy', name: 'Happy' },
  { id: 'wink', name: 'Wink' },
  { id: 'sleepy', name: 'Sleepy' },
  { id: 'sparkle', name: 'Sparkly' },
  { id: 'hearts', name: 'Heart eyes' },
  { id: 'surprised', name: 'Surprised' },
  { id: 'cool', name: 'Cool' },
  { id: 'starry', name: 'Star eyes' },
  { id: 'teary', name: 'Teary' }
]);

export const MOUTHS = deepFreeze([
  { id: 'none', name: 'No mouth' },
  { id: 'smile', name: 'Smile' },
  { id: 'grin', name: 'Grin' },
  { id: 'cat', name: 'Cat mouth' },
  { id: 'o', name: 'Oh' },
  { id: 'tongue', name: 'Tongue out' },
  { id: 'fangs', name: 'Fangs' },
  { id: 'kiss', name: 'Kiss' }
]);

// Display order of the Boy / Girl control; boy is the default. Only lashes and the order of the
// look grid depend on it.
export const GENDERS = deepFreeze([
  { id: 'boy', name: 'Boy' },
  { id: 'girl', name: 'Girl' }
]);

// A look's audience is one of these ids. looksFor() decides their order per gender.
export const LOOK_GROUPS = deepFreeze([
  { id: 'boy', name: 'Boy looks' },
  { id: 'girl', name: 'Girl looks' },
  { id: 'all', name: 'For everyone' }
]);

// The six slots a look sets, in the order of the rows below. Lashes belong to the gender.
export const LOOK_SLOTS = deepFreeze(['hat', 'glasses', 'extra', 'face', 'mouth', 'blush']);

// id, name, 'hat/glasses/extra/face/mouth/blush', audience
const LOOK_ROWS = [
  ['classic', 'Classic', 'none/none/none/dot/smile/0', 'all'],
  ['cozy', 'Cozy', 'beanie/none/scarf/happy/smile/1', 'all'],
  ['sporty', 'Sporty', 'cap/sunnies/none/dot/grin/0', 'all'],
  ['dapper', 'Dapper', 'tophat/monocle/bowtie/dot/none/0', 'boy'],
  ['royal', 'Royal', 'crown/none/cape/dot/smile/0', 'boy'],
  ['princess', 'Princess', 'tiara/none/pearls/sparkle/smile/1', 'girl'],
  ['wizard', 'Wizard', 'wizard/round/none/dot/none/0', 'boy'],
  ['artist', 'Artist', 'beret/none/scarf/happy/smile/0', 'all'],
  ['party', 'Party', 'party/none/bowtie/happy/grin/1', 'all'],
  ['chef', 'Chef', 'chef/none/bandana/happy/smile/0', 'all'],
  ['explorer', 'Explorer', 'bucket/sunnies/backpack/dot/smile/0', 'all'],
  ['cowpoke', 'Cowpoke', 'cowboy/none/bandana/wink/grin/0', 'all'],
  ['beach', 'Beach day', 'sunhat/hearts/none/happy/smile/1', 'girl'],
  ['garden', 'Garden', 'flowers/none/none/happy/smile/1', 'girl'],
  ['angel', 'Angel', 'halo/none/wings/sleepy/smile/1', 'all'],
  ['sweet', 'Sweet', 'bow/none/pearls/sparkle/smile/1', 'girl'],
  ['scholar', 'Scholar', 'none/round/bowtie/dot/none/0', 'all'],
  ['cool', 'Cool', 'none/sunnies/none/cool/smile/0', 'all'],
  ['star', 'Star', 'none/stars/none/sparkle/grin/0', 'all'],
  ['love', 'Love', 'none/hearts/none/hearts/smile/1', 'all'],
  ['future', 'Future', 'none/visor/headphones/dot/none/0', 'all'],
  ['dj', 'DJ', 'cap/none/headphones/cool/grin/0', 'all'],
  ['gamer', 'Gamer', 'none/square/headset/dot/o/0', 'all'],
  ['nap', 'Nap time', 'nightcap/none/none/sleepy/o/1', 'all'],
  ['wow', 'Wow', 'none/none/none/surprised/o/0', 'all'],
  ['pet', 'Pet', 'none/none/bell/happy/cat/1', 'all'],
  ['hiker', 'Hiker', 'bucket/none/backpack/happy/smile/0', 'all'],
  ['sprout', 'Sprout', 'none/none/sprout/happy/smile/1', 'all'],
  ['blossom', 'Blossom', 'none/none/flower/wink/smile/1', 'girl'],
  ['office', 'Office', 'none/square/necktie/dot/smile/0', 'all'],
  ['cheeky', 'Cheeky', 'none/none/none/wink/tongue/1', 'all'],
  ['rockstar', 'Rock star', 'none/stars/bandana/cool/grin/0', 'all'],
  ['pirate', 'Pirate', 'pirate/eyepatch/bandana/dot/grin/0', 'boy'],
  ['detective', 'Detective', 'detective/monocle/necktie/dot/none/0', 'boy'],
  ['ninja', 'Ninja', 'ninja/none/none/cool/none/0', 'boy'],
  ['viking', 'Viking', 'viking/none/none/dot/grin/0', 'boy'],
  ['lady', 'Lady', 'pillbox/none/pearls/dot/smile/1', 'girl'],
  ['witch', 'Witch', 'witch/none/none/wink/smile/1', 'girl'],
  ['kitty', 'Kitty', 'none/none/catphones/happy/cat/1', 'girl'],
  ['sweetheart', 'Sweetheart', 'none/none/heartclip/dot/kiss/1', 'girl'],
  ['fairy', 'Fairy', 'flowers/none/wings/sparkle/smile/1', 'girl'],
  ['kitten', 'Kitten', 'catears/cateye/none/wink/cat/1', 'girl'],
  ['dreamer', 'Dreamer', 'moon/none/none/happy/smile/0', 'all'],
  ['cosmic', 'Cosmic', 'boppers/none/none/starry/o/0', 'all'],
  ['athlete', 'Athlete', 'sweatband/none/medal/dot/grin/0', 'all'],
  ['hero', 'Hero', 'none/none/cape/cool/grin/0', 'all'],
  ['graduate', 'Graduate', 'grad/round/none/happy/smile/0', 'all'],
  ['aviator', 'Aviator', 'none/goggles/scarf/dot/grin/0', 'all'],
  ['spooky', 'Spooky', 'none/none/cape/dot/fangs/0', 'all'],
  ['whizkid', 'Whiz kid', 'propeller/round/none/surprised/o/0', 'all']
];

export const LOOKS = deepFreeze(LOOK_ROWS.map(function (row) {
  const v = row[2].split('/');
  return {
    id: row[0], name: row[1],
    hat: v[0], glasses: v[1], extra: v[2], face: v[3], mouth: v[4], blush: v[5] === '1',
    audience: row[3]
  };
}));

// switchGender() trades a look meant for one gender for its match, both ways.
export const LOOK_COUNTERPARTS = deepFreeze({
  dapper: 'lady', lady: 'dapper',
  royal: 'princess', princess: 'royal',
  wizard: 'witch', witch: 'wizard'
});

// The default character is exactly the Cozy look, a boy, so without lashes.
export const DEFAULTS = deepFreeze({
  shape: 'round', color: 'ffd34e', finish: 'plush', gender: 'boy', look: 'cozy',
  hat: 'beanie', glasses: 'none', extra: 'scarf', face: 'happy', mouth: 'smile',
  blush: true, lashes: false
});

// Every option list by state key, for the UI and for list_dot_avatar_options.
export const OPTION_LISTS = deepFreeze({
  shape: SHAPES, color: COLORS, finish: FINISHES, gender: GENDERS, look: LOOKS,
  hat: HATS, glasses: GLASSES, extra: EXTRAS, face: FACES, mouth: MOUTHS
});

/* ---------------------------------------------------------------- lookups */

// Canonical key order of the query string (spec 8 plus gender), which is also the state's order.
const STATE_KEYS = ['shape', 'color', 'finish', 'gender', 'hat', 'glasses', 'extra', 'face', 'mouth', 'blush', 'lashes'];
const INPUT_KEYS = ['look'].concat(STATE_KEYS);
const ENUM_KEYS = ['shape', 'finish', 'gender', 'hat', 'glasses', 'extra', 'face', 'mouth'];

const SITE_URL = 'https://siter.io/dot-avatar-maker';
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/;

// 'Top hat', 'top-hat', ' TOPHAT ' -> 'tophat'
function aliasKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// kind -> Map(aliasKey -> item), built from each item's id and name. An earlier entry wins,
// so an id can never be shadowed by another option's name (none collide today).
const BY_ALIAS = {};
const BY_ID = {};
Object.keys(OPTION_LISTS).forEach(function (kind) {
  const alias = new Map();
  const ids = new Map();
  OPTION_LISTS[kind].forEach(function (item) {
    ids.set(item.id, item);
    if (!alias.has(aliasKey(item.id))) alias.set(aliasKey(item.id), item);
  });
  OPTION_LISTS[kind].forEach(function (item) {
    if (!alias.has(aliasKey(item.name))) alias.set(aliasKey(item.name), item);
  });
  BY_ALIAS[kind] = alias;
  BY_ID[kind] = ids;
});

const COLOR_BY_HEX = new Map(COLORS.map(function (c) { return [c.hex, c]; }));
const OTHER_FINISHES = FINISHES.filter(function (f) { return f.id !== 'plush'; });

// The Look grid's groups per gender, all 50 looks each time: that gender's own looks first, then
// everyone's, then the other gender's. random() draws only from the first two groups.
const GROUP_ORDER = { boy: ['boy', 'all', 'girl'], girl: ['girl', 'all', 'boy'] };
const LOOKS_FOR = {};
const LOOK_POOL = {};
GENDERS.forEach(function (g) {
  LOOKS_FOR[g.id] = deepFreeze(GROUP_ORDER[g.id].map(function (audience) {
    const group = LOOK_GROUPS.filter(function (x) { return x.id === audience; })[0];
    return {
      id: group.id, name: group.name,
      items: LOOKS.filter(function (l) { return l.audience === audience; })
    };
  }));
  LOOK_POOL[g.id] = LOOKS_FOR[g.id][0].items.concat(LOOKS_FOR[g.id][1].items);
});

// What validate() tells a person or an agent the field accepts.
const EXPECTED = {};
ENUM_KEYS.concat(['look']).forEach(function (k) {
  EXPECTED[k] = 'one of ' + OPTION_LISTS[k].map(function (o) { return o.id; }).join(', ');
});
EXPECTED.gender = 'boy or girl';
EXPECTED.color = 'a preset (' + COLORS.map(function (c) { return c.id; }).join(', ') +
  ') or a hex color with 3 or 6 digits, with or without #, such as 3a7d5c';
EXPECTED.blush = EXPECTED.lashes = 'true or false (1 or 0 in a link)';

// Phrases for describe(). Shapes read as their lowercase name and hats, glasses and extras are
// built from their names (see itemPhrase), except where these maps say otherwise.
const SHAPE_PHRASE = { ears: 'tiny-eared dot' };
const ITEM_PHRASE = { hat: { viking: 'a Viking helmet' }, glasses: {}, extra: {} };
const FACE_PHRASE = {
  dot: 'dot eyes', happy: 'a happy face', wink: 'a wink', sleepy: 'a sleepy face',
  sparkle: 'sparkly eyes', hearts: 'heart eyes', surprised: 'a surprised face', cool: 'a cool face',
  starry: 'star eyes', teary: 'teary eyes'
};
const MOUTH_PHRASE = {
  smile: 'a smile', grin: 'a grin', cat: 'a cat mouth', o: 'an O-shaped mouth',
  tongue: 'a tongue sticking out', fangs: 'little fangs', kiss: 'a puckered kiss'
};

/* ---------------------------------------------------------------- parsing helpers */

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}

function given(v) {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

function matchOption(kind, v) {
  if (typeof v !== 'string') return null;
  return BY_ALIAS[kind].get(aliasKey(v)) || null;
}

// The gender id for any input; null when it is not a gender.
function genderId(v) {
  const g = matchOption('gender', v);
  return g ? g.id : null;
}

function lashesDefault(gender) {
  return gender === 'girl';
}

// Preset id or name, or 3/6-digit hex with or without '#'. Returns 6 lowercase digits or null.
function parseColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const m = HEX_RE.exec(s);
  if (!m) {
    const preset = BY_ALIAS.color.get(aliasKey(s));
    return preset ? preset.hex : null;
  }
  const h = m[1];
  return h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
}

function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return null;
}

function defaultState() {
  const s = {};
  STATE_KEYS.forEach(function (k) { s[k] = DEFAULTS[k]; });
  return s;
}

function isQueryLike(v) {
  return typeof v === 'string' ||
    (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) ||
    (typeof URL !== 'undefined' && v instanceof URL);
}

// A query string (with or without '?', a full URL, URLSearchParams or URL) -> {partial, unknown}.
// The first occurrence of a key wins, as URLSearchParams.get() does.
function readQuery(search) {
  let params;
  if (typeof URL !== 'undefined' && search instanceof URL) {
    params = search.searchParams;
  } else if (typeof URLSearchParams !== 'undefined' && search instanceof URLSearchParams) {
    params = search;
  } else {
    let s = search == null ? '' : String(search);
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(0, hash);
    const q = s.indexOf('?');
    if (q >= 0) s = s.slice(q + 1);
    else if (s.indexOf('://') >= 0 || s.charAt(0) === '/') s = '';   // a URL without a query
    params = new URLSearchParams(s);
  }
  const partial = {};
  const unknown = [];
  params.forEach(function (value, key) {
    if (INPUT_KEYS.indexOf(key) >= 0) {
      if (!Object.prototype.hasOwnProperty.call(partial, key)) partial[key] = value;
    } else if (unknown.indexOf(key) < 0) {
      unknown.push(key);
    }
  });
  return { partial: partial, unknown: unknown };
}

// The one pass behind normalize() and validate(). May throw on hostile input; callers catch.
function resolve(input) {
  let src = input;
  const unknown = [];
  if (isQueryLike(input)) {
    const read = readQuery(input);
    src = read.partial;
    Array.prototype.push.apply(unknown, read.unknown);
  }
  const obj = src && typeof src === 'object' ? src : {};
  const state = defaultState();
  const invalid = [];
  const get = function (k) { try { return obj[k]; } catch (e) { return undefined; } };
  const bad = function (k, v) { invalid.push({ key: k, value: v, expected: EXPECTED[k] }); };
  // A boolean field: true or false when given and readable, null otherwise (reported if given).
  const readBool = function (k) {
    const v = get(k);
    if (!given(v)) return null;
    const b = parseBool(v);
    if (b === null) bad(k, v);
    return b;
  };

  // 1. The look is the base for its six slots.
  const lookValue = get('look');
  if (given(lookValue)) {
    const look = matchOption('look', lookValue);
    if (look) LOOK_SLOTS.forEach(function (k) { state[k] = look[k]; });
    else bad('look', lookValue);
  }
  // 2. Explicit slots win.
  ENUM_KEYS.forEach(function (k) {
    const v = get(k);
    if (!given(v)) return;
    const item = matchOption(k, v);
    if (item) state[k] = item.id;
    else bad(k, v);
  });
  const colorValue = get('color');
  if (given(colorValue)) {
    const hex = parseColor(colorValue);
    if (hex) state.color = hex;
    else bad('color', colorValue);
  }
  const blush = readBool('blush');
  if (blush !== null) state.blush = blush;
  // 3. Lashes last, once the gender is known: not given or unreadable means the gender's default.
  const lashes = readBool('lashes');
  state.lashes = lashes !== null ? lashes : lashesDefault(state.gender);

  let keys = [];
  try { keys = Object.keys(obj); } catch (e) { keys = []; }
  keys.forEach(function (k) {
    if (INPUT_KEYS.indexOf(k) < 0 && unknown.indexOf(k) < 0) unknown.push(k);
  });
  return { state: state, invalid: invalid, unknown: unknown };
}

function listJoin(items) {
  if (items.length < 2) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// 'Top hat' -> 'a top hat', 'Sunglasses' -> 'sunglasses', 'Eye patch' -> 'an eye patch'.
function itemPhrase(name) {
  const n = name.toLowerCase();
  if (/s$/.test(n)) return n;
  return (/^[aeiou]/.test(n) ? 'an ' : 'a ') + n;
}

function slotPhrase(kind, id) {
  return ITEM_PHRASE[kind][id] || itemPhrase(BY_ID[kind].get(id).name);
}

/* ---------------------------------------------------------------- state API */

/* Any partial state (an object, or a query string) -> a complete state. Never throws. */
export function normalize(partial) {
  try {
    return resolve(partial).state;
  } catch (e) {
    return defaultState();
  }
}

/* normalize() with a report, for the link status line and WebMCP errors:
 * {state, invalid: [{key, value, expected}], unknown: [key]}. Never throws. */
export function validate(partial) {
  try {
    return resolve(partial);
  } catch (e) {
    return { state: defaultState(), invalid: [], unknown: [] };
  }
}

/* Sets the six look slots from the look; keeps shape, color, finish, gender and lashes. An
 * unknown look id leaves the state as it was (normalized). Never mutates its input. */
export function applyLook(state, lookId) {
  const s = normalize(state);
  const look = matchOption('look', lookId);
  if (look) LOOK_SLOTS.forEach(function (k) { s[k] = look[k]; });
  return s;
}

/* The id of the LOOK whose six slots all equal the state's, or null for "Custom". Gender and
 * lashes play no part. */
export function lookOf(state) {
  const s = normalize(state);
  for (let i = 0; i < LOOKS.length; i++) {
    const look = LOOKS[i];
    let same = true;
    for (let j = 0; j < LOOK_SLOTS.length && same; j++) same = look[LOOK_SLOTS[j]] === s[LOOK_SLOTS[j]];
    if (same) return look.id;
  }
  return null;
}

/* What a gender changes by default: {lashes}. An unknown gender reads as boy. */
export function genderDefaults(gender) {
  return { lashes: lashesDefault(genderId(gender) || DEFAULTS.gender) };
}

/* The Look grid's groups for a gender, in display order, all 50 looks every time:
 * boy -> [boy, all, girl], girl -> [girl, all, boy]. Each entry is {id, name, items: [LOOK...]}
 * in table order. The same frozen array comes back on every call; an unknown gender reads as
 * boy. */
export function looksFor(gender) {
  return LOOKS_FOR[genderId(gender) || DEFAULTS.gender];
}

/* A gender change -> {state, swapped}. Sets the gender and its lashes default. When the current
 * look is meant for the other gender and has a counterpart in LOOK_COUNTERPARTS, applies the
 * counterpart and reports swapped = {from, to}; otherwise swapped is null and the slots are
 * untouched. The same gender, or an unknown one, changes nothing. Never mutates its input. */
export function switchGender(state, gender) {
  const s = normalize(state);
  const g = genderId(gender);
  if (!g || g === s.gender) return { state: s, swapped: null };
  s.gender = g;
  s.lashes = lashesDefault(g);
  let swapped = null;
  const from = lookOf(s);
  const look = from && BY_ID.look.get(from);
  const to = from && Object.prototype.hasOwnProperty.call(LOOK_COUNTERPARTS, from) ? LOOK_COUNTERPARTS[from] : null;
  if (look && to && look.audience !== 'all' && look.audience !== g) {
    const target = BY_ID.look.get(to);
    LOOK_SLOTS.forEach(function (k) { s[k] = target[k]; });
    swapped = { from: from, to: to };
  }
  return { state: s, swapped: swapped };
}

/* location.search (or any query-like value) -> a complete state. Never throws. */
export function fromQuery(search) {
  try {
    return resolve(readQuery(search).partial).state;
  } catch (e) {
    return defaultState();
  }
}

/* A complete state -> '' or '?key=value&...' in canonical order, no look, defaults omitted:
 * gender when boy, lashes when it equals the gender's default. */
export function toQuery(state) {
  const s = normalize(state);
  const parts = [];
  STATE_KEYS.forEach(function (k) {
    const def = k === 'lashes' ? lashesDefault(s.gender) : DEFAULTS[k];
    if (s[k] === def) return;
    const v = typeof s[k] === 'boolean' ? (s[k] ? '1' : '0') : s[k];
    parts.push(k + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/* A human sentence, no ids, no gender: "Butter round, short plush, with a beanie, a scarf, a
 * happy face, a smile and rosy cheeks". Slots set to none are left out. */
export function describe(state) {
  const s = normalize(state);
  const items = [];
  if (s.hat !== 'none') items.push(slotPhrase('hat', s.hat));
  if (s.glasses !== 'none') items.push(slotPhrase('glasses', s.glasses));
  if (s.extra !== 'none') items.push(slotPhrase('extra', s.extra));
  items.push(FACE_PHRASE[s.face]);
  if (s.mouth !== 'none') items.push(MOUTH_PHRASE[s.mouth]);
  if (s.blush) items.push('rosy cheeks');
  if (s.lashes) items.push('lashes');
  const shape = SHAPE_PHRASE[s.shape] || BY_ID.shape.get(s.shape).name.toLowerCase();
  return colorName(s.color) + ' ' + shape + ', ' +
    BY_ID.finish.get(s.finish).name.toLowerCase() + ', with ' + listJoin(items);
}

/* A preset's name ('Butter') or '#RRGGBB' for a custom color; '' if it is not a color. */
export function colorName(hex) {
  const h = parseColor(hex);
  if (!h) return '';
  const preset = COLOR_BY_HEX.get(h);
  return preset ? preset.name : '#' + h.toUpperCase();
}

/* The display name of an option ('hat', 'tophat' -> 'Top hat'); colors go through colorName.
 * '' when the kind or the id is unknown. */
export function nameOf(kind, id) {
  if (kind === 'color') return colorName(id);
  const map = BY_ID[kind];
  const item = map && map.get(id);
  return item ? item.name : '';
}

/* A random character from rng() in [0, 1), defaulting to Math.random. opts.gender (default boy)
 * is kept and sets lashes; the look comes from that gender's own looks plus everyone's, never
 * the other gender's. Exactly nine draws: shape, color roll, preset, lightness, chroma, hue,
 * finish roll, finish pick, look. */
export function random(rng, opts) {
  const next = typeof rng === 'function' ? rng : Math.random;
  const draw = function () {
    const r = Number(next());
    return r >= 0 && r < 1 ? r : 0;
  };
  const pick = function (list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; };
  let wanted;
  try { wanted = opts && typeof opts === 'object' ? opts.gender : undefined; } catch (e) { wanted = undefined; }
  const gender = genderId(wanted) || DEFAULTS.gender;
  const shape = pick(SHAPES, draw());
  const custom = draw() < CUSTOM_SHARE;
  const preset = pick(COLORS, draw());
  const l = draw(), c = draw(), h = draw();
  const roll = draw();
  const other = pick(OTHER_FINISHES, draw());
  const look = pick(LOOK_POOL[gender], draw());
  return applyLook({
    shape: shape.id,
    color: custom ? customColor(l, c, h) : preset.hex,
    finish: roll < 0.4 ? 'plush' : other.id,
    gender: gender
  }, look.id);
}

/* mulberry32, the small public-domain 32-bit PRNG the house tools already use for seeds. */
export function mulberry32(seed) {
  let t = Number(seed) >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* The share link that reproduces the character exactly. */
export function siteUrl(state) {
  return SITE_URL + toQuery(state);
}

/* 'dot-avatar-<shape>-<finish>': the exporter adds '.png', '-profile.png' or '.html'. */
export function fileBase(state) {
  const s = normalize(state);
  return 'dot-avatar-' + s.shape + '-' + s.finish;
}

/* ---------------------------------------------------------------- random custom colors */

// OKLab is Björn Ottosson's perceptual color space (2020); these are its published matrices.
// OKLCH is OKLab in polar form: lightness L 0-1, chroma C, hue h in degrees.
const CUSTOM_SHARE = 0.25;          // how often random() makes up a color instead of a preset
const CUSTOM_L = [0.723, 0.897];    // the 0.72-0.9 band, inset by twice what 8-bit rounding moves L
const CUSTOM_C = [0.55, 0.9];       // share of the most vivid in-gamut chroma at that L and hue
const GAMUT_EPS = 1e-7;

// OKLCH -> linear sRGB [r, g, b]; in gamut when every channel is within 0-1.
function oklchToLinear(L, C, hDeg) {
  const h = hDeg * Math.PI / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
  ];
}

function inGamut(L, C, h) {
  const rgb = oklchToLinear(L, C, h);
  for (let i = 0; i < 3; i++) if (!(rgb[i] >= -GAMUT_EPS && rgb[i] <= 1 + GAMUT_EPS)) return false;
  return true;
}

// The most vivid chroma sRGB can show at this lightness and hue: a 24-step binary search
// (sRGB never goes past about 0.33, so 0.4 is a safe ceiling).
function maxChroma(L, h) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// A linear channel -> two hex digits (the sRGB transfer curve, clamped, rounded to 8 bits).
function channelHex(x) {
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  const n = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (n < 16 ? '0' : '') + n.toString(16);
}

// Three draws in [0, 1) -> lightness, chroma share and hue -> 6 lowercase hex digits.
function customColor(u, v, w) {
  const L = CUSTOM_L[0] + u * (CUSTOM_L[1] - CUSTOM_L[0]);
  const h = w * 360;
  const C = (CUSTOM_C[0] + v * (CUSTOM_C[1] - CUSTOM_C[0])) * maxChroma(L, h);
  const rgb = oklchToLinear(L, C, h);
  return channelHex(rgb[0]) + channelHex(rgb[1]) + channelHex(rgb[2]);
}
