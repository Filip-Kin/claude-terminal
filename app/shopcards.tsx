/**
 * Shopping result gallery.
 *
 * The shop MCP server (Projects/shop-mcp) appends a fenced ```shop-cards block
 * to its tool output carrying the listings as JSON. MCP has no way to render
 * UI — a tool returns text and the client decides what to draw — and since we
 * own both ends, this draws them as a horizontal strip of cards instead of the
 * usual collapsed tool accordion.
 *
 * Any client without this renderer still gets a readable answer: the plain text
 * above the fence is the real output, and the fence is inert.
 *
 * `note` is the reason the gallery exists. A search fills cards with price and
 * postage; only `present_results` fills the note, because only by then has the
 * model read the listings and formed a view. Cards carrying a note lead with it.
 */

import { useRef, useState } from "react";

export interface ShopCard {
  source: "amazon" | "ebay";
  id: string;
  title: string;
  url: string;
  image?: string;
  price?: string;
  was?: string;
  total?: string;
  shipping?: string;
  condition?: string;
  rating?: number;
  reviews?: number;
  seller?: string;
  sponsored?: boolean;
  note?: string;
  deal?: string;
  dealKind?: "low" | "high" | "mid" | "thin";
  rejected?: boolean;
}

export interface ShopCardPayload {
  v: 1;
  title: string;
  cards: ShopCard[];
}

/**
 * Pull every shop-cards block out of a tool result, returning the payloads and
 * the text with those blocks removed.
 *
 * Returns the stripped text so a caller can show the prose without the JSON
 * underneath it, which would otherwise be the longest thing on screen.
 */
export function extractShopCards(raw: string): { payloads: ShopCardPayload[]; rest: string } {
  const payloads: ShopCardPayload[] = [];
  const rest = raw.replace(/```shop-cards\n([\s\S]*?)\n```/g, (_m, json: string) => {
    try {
      const p = JSON.parse(json) as ShopCardPayload;
      if (p && Array.isArray(p.cards) && p.cards.length) payloads.push(p);
    } catch {
      // A truncated block mid-stream is normal; leave it out rather than throw.
    }
    return "";
  });
  return { payloads, rest: rest.trim() };
}

function Stars({ rating, reviews }: { rating?: number; reviews?: number }) {
  if (rating === undefined) return null;
  return (
    <span className="sc-rating">
      {rating.toFixed(1)}★{reviews ? ` (${reviews.toLocaleString()})` : ""}
    </span>
  );
}

function Card({ c }: { c: ShopCard }) {
  return (
    <article className={"sc-card" + (c.rejected ? " sc-out" : "")}>
      <div className="sc-thumb">
        {c.image ? (
          <img src={c.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <div className="sc-noimg" aria-hidden="true" />
        )}
        <span className={"sc-src sc-src-" + c.source}>{c.source === "amazon" ? "Amazon" : "eBay"}</span>
        {/* A status label, not a control. This started as a red ✗ in the
            top-right corner, which is where a close button lives, so it read as
            something to press and did nothing when pressed. */}
        {c.rejected && <span className="sc-flag">Ruled out</span>}
      </div>

      <div className="sc-body">
        <h4 className="sc-title" title={c.title}>{c.title}</h4>

        <div className="sc-price">
          {c.price && <strong>{c.price}</strong>}
          {c.was && <s>{c.was}</s>}
          {c.total && c.total !== c.price && <span className="sc-total">{c.total} total</span>}
        </div>

        <div className="sc-meta">
          <Stars rating={c.rating} reviews={c.reviews} />
          {c.condition && <span>{c.condition}</span>}
          {c.sponsored && <span className="sc-ad">Sponsored</span>}
        </div>

        {/* Price verdict, kept visually separate from the note: "is this a good
            price" and "is this the right product" are different questions and
            the answer to one should not hide inside the other. */}
        {c.deal && <div className={"sc-deal sc-deal-" + (c.dealKind ?? "mid")}>{c.deal}</div>}
        {c.shipping && <div className="sc-ship">{c.shipping}</div>}
        {c.seller && <div className="sc-seller">{c.seller}</div>}
        {c.note && <p className="sc-note">{c.note}</p>}
      </div>

      <a className="sc-go" href={c.url} target="_blank" rel="noopener noreferrer">
        {c.source === "amazon" ? "Amazon" : "eBay"}
      </a>
    </article>
  );
}

export function ShopGallery({ payload }: { payload: ShopCardPayload }) {
  const strip = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  // Arrows are a desktop affordance; a touch screen just swipes. They hide at
  // the ends so there is never a control that does nothing when pressed.
  function onScroll() {
    const el = strip.current;
    if (!el) return;
    setAtStart(el.scrollLeft < 8);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 8);
  }

  function nudge(dir: 1 | -1) {
    const el = strip.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  }

  const kept = payload.cards.filter((c) => !c.rejected).length;
  const total = payload.cards.length;

  return (
    <section className="sc-wrap">
      <header className="sc-head">
        <span className="sc-h-title">{payload.title}</span>
        <span className="sc-h-count">{kept === total ? `${total}` : `${kept} of ${total}`}</span>
      </header>

      <div className="sc-strip-wrap">
        {!atStart && (
          <button className="sc-arrow sc-left" onClick={() => nudge(-1)} aria-label="Previous">
            ‹
          </button>
        )}
        <div className="sc-strip" ref={strip} onScroll={onScroll}>
          {payload.cards.map((c) => (
            <Card key={c.source + c.id} c={c} />
          ))}
        </div>
        {!atEnd && (
          <button className="sc-arrow sc-right" onClick={() => nudge(1)} aria-label="Next">
            ›
          </button>
        )}
      </div>
    </section>
  );
}
