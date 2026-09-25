/**
 * Builds lib/feed/catalog.json — the Scroll's blue-chip museum catalog
 * (AGENTS.md §18). Run by hand when the catalog should grow:
 *
 *   npx tsx scripts/build-catalog.ts
 *
 * Public-domain paintings with a Commons image, in the museums below, by
 * artists famous enough to have 70+ Wikipedia articles. The live version of
 * this query (random order across all museums at once) started timing out at
 * Wikidata in Sept 2026, which silently dropped the feed to Met-search
 * leftovers — so the catalog is now built once, one museum at a time, and
 * shipped as a file.
 *
 * Artists whose paintings already look modern are left out: a new version of
 * one reads as a knockoff of it (Jeff, Sept 25 2026, on Cézanne's Card
 * Players). The museum judge applies the same rule painting by painting.
 */

import fs from "node:fs";

const MUSEUMS: Record<string, string> = {
  Q160236: "The Met",
  Q510324: "Philadelphia Museum of Art",
  Q808462: "Barnes Foundation",
  Q239303: "Art Institute of Chicago",
  Q214867: "National Gallery of Art",
  Q23402: "Musée d'Orsay",
  Q180788: "National Gallery, London",
  Q19675: "Louvre",
  Q190804: "Rijksmuseum",
  Q160112: "Prado",
  Q51252: "Uffizi",
  Q95569: "Kunsthistorisches Museum",
  Q1134541: "Courtauld Gallery",
  Q49133: "Museum of Fine Arts, Boston",
  Q1099141: "Clark Art Institute",
  Q1270597: "Phillips Collection",
  Q657415: "Cleveland Museum of Art",
  Q154568: "Alte Pinakothek",
  Q170152: "Neue Pinakothek",
  Q163804: "Städel",
  Q430682: "Tate",
  Q536705: "Musée de l'Orangerie",
};

/** Already-modern painters (by English label). The judge catches the rest. */
const MODERN = new Set([
  "Paul Cézanne", "Vincent van Gogh", "Paul Gauguin", "Georges Seurat", "Paul Signac", "Henri Matisse",
  "Pablo Picasso", "Georges Braque", "André Derain", "Maurice de Vlaminck", "Fernand Léger", "Juan Gris",
  "Wassily Kandinsky", "Paul Klee", "Piet Mondrian", "Amedeo Modigliani", "Egon Schiele", "Edvard Munch",
  "Ernst Ludwig Kirchner", "Franz Marc", "August Macke", "Pierre Bonnard", "Édouard Vuillard", "Maurice Denis",
  "Paul Sérusier", "Henri Rousseau", "Marc Chagall", "Joan Miró", "Robert Delaunay", "Henri de Toulouse-Lautrec",
  "Gustav Klimt", "Odilon Redon", "James Ensor", "Emil Nolde", "Kazimir Malevich", "Umberto Boccioni",
  "Giorgio de Chirico", "Chaïm Soutine", "Kees van Dongen", "Raoul Dufy", "Albert Marquet", "Félix Vallotton",
  "Georgia O'Keeffe", "Alexej von Jawlensky", "Oskar Kokoschka", "Max Beckmann", "Katsushika Hokusai",
  "Utagawa Hiroshige", "Kitagawa Utamaro", "Matsuo Bashō", "Diego Rivera", "Alphonse Mucha", "William Blake",
]);

const PER_ARTIST = 40;

type Row = { p: { value: string }; title: { value: string }; creator: { value: string }; creatorLabel: { value: string }; inception?: { value: string }; img: { value: string } };

async function sparql(q: string): Promise<Row[]> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), {
      headers: { Accept: "application/sparql-results+json", "User-Agent": "zuzi-studio/1.0 (catalog build; jashbrook@gmail.com)" },
    });
    if (r.ok) return ((await r.json()) as { results: { bindings: Row[] } }).results.bindings;
    if (attempt >= 4) throw new Error(`wikidata ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * attempt));
  }
}

async function main() {
  const byQ = new Map<string, { q: string; t: string; a: string; aq: string; y: string; m: string; f: string }>();
  for (const [mq, museum] of Object.entries(MUSEUMS)) {
    const rows = await sparql(`SELECT ?p ?title ?creator ?creatorLabel ?inception ?img WHERE {
  ?p wdt:P195 wd:${mq} ; wdt:P31 wd:Q3305213 ; wdt:P18 ?img ; wdt:P6216 wd:Q19652 ; wdt:P170 ?creator .
  ?creator wikibase:sitelinks ?sl . FILTER(?sl >= 70)
  ?p rdfs:label ?title . FILTER(LANG(?title) = "en")
  ?creator rdfs:label ?creatorLabel . FILTER(LANG(?creatorLabel) = "en")
  OPTIONAL { ?p wdt:P571 ?inception . }
} LIMIT 6000`);
    let added = 0;
    for (const b of rows) {
      const q = b.p.value.split("/").pop() as string;
      if (byQ.has(q) || MODERN.has(b.creatorLabel.value)) continue;
      const year = (b.inception?.value ?? "").slice(0, 4).replace(/^\+/, "");
      byQ.set(q, {
        q,
        t: b.title.value,
        a: b.creatorLabel.value,
        aq: b.creator.value.split("/").pop() as string,
        y: /^\d{3,4}$/.test(year) ? year : "",
        m: museum,
        f: decodeURIComponent(b.img.value.split("/Special:FilePath/")[1] ?? ""),
      });
      added++;
    }
    console.log(`${museum}: ${rows.length} rows, ${added} new`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  // Cap each artist so the famous few don't crowd everyone else out.
  const perArtist = new Map<string, number>();
  const out = [...byQ.values()]
    .filter((e) => e.f)
    .sort((x, y) => x.q.localeCompare(y.q))
    .filter((e) => {
      const n = (perArtist.get(e.aq) ?? 0) + 1;
      perArtist.set(e.aq, n);
      return n <= PER_ARTIST;
    });
  fs.writeFileSync("lib/feed/catalog.json", JSON.stringify(out) + "\n");
  console.log(`catalog: ${out.length} paintings by ${perArtist.size} artists`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
