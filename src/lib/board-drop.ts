/**
 * Turns a drop into neighbour intent. Pure, so the verification script can
 * exercise it without a browser.
 *
 * A move sends `prev_card_id` and `next_card_id` and lets the server compute the
 * key between them. Nothing downstream checks that the pair is adjacent: the
 * route validates only that both cards exist and sit in the destination scope
 * (`src/app/api/v1/cards/[id]/move/route.ts`), and `computePosition` only refuses
 * when `prev >= next` (`src/lib/ordering.ts`). A far-apart pair is accepted, and
 * the card lands somewhere in the gap.
 *
 * That is fine while every card is on screen, because then the visible
 * neighbours are the real ones. Under a filter they are not, so the drop has to
 * be resolved against the unfiltered list — otherwise dropping between two
 * visible cards drops the card into the middle of a hidden run, at a spot the
 * user never chose and cannot see until the filter is cleared.
 */
import type { BoardCard } from "@/types/board";

export type DropResolution = {
  /** Insertion index within `fullList`, for the optimistic payload. */
  index: number;
  prevId: number | null;
  nextId: number | null;
};

/**
 * `fullList` is the destination scope in `position ASC, id ASC` order with the
 * moving card already removed. `overCardId` is the visible card the pointer
 * landed on, or null when the drop landed on the container itself.
 *
 * Landing on a card inserts immediately before it *in the full list*, so every
 * hidden card keeps its position. With no filter active the visible list is the
 * full list and this reduces to the original arithmetic.
 *
 * The gesture anchors to the card under the pointer, not to the visible card
 * above it. Dropping "between" two visible cards with a hidden run between them
 * therefore lands past the whole run rather than inside it. Anchoring to the
 * card above would be equally well defined, but it would stop matching what an
 * unfiltered drag does, and the returned pair is adjacent either way — which is
 * the property that keeps the server from minting a key among hidden cards.
 */
export function resolveDrop(
  fullList: BoardCard[],
  overCardId: number | null,
): DropResolution {
  const index =
    overCardId === null
      ? -1
      : fullList.findIndex((card) => card.id === overCardId);

  // Dropped on the container, or on a card that is not in this scope — append.
  if (index < 0) {
    return {
      index: fullList.length,
      prevId: fullList[fullList.length - 1]?.id ?? null,
      nextId: null,
    };
  }

  return {
    index,
    prevId: fullList[index - 1]?.id ?? null,
    nextId: fullList[index].id,
  };
}
