/** Boat's credit for people EACbot introduces to Boat. The person claims it by writing to Boat themselves: the app only
 * opens a draft they send, so nothing is ever claimed for them. */
export interface BoatOffer {
  url: string;
  /** Boat's billing and account address. */
  claimTo: string;
  /** Boat's team reads the claim, so it stays in English whatever the app's language. */
  subject: string;
  body: string;
  /** From this time (epoch ms) the offer shows nowhere; null while Boat has named no end date. */
  until: number | null;
}

export const BOAT_OFFER: BoatOffer = {
  url: "https://boat.dev",
  claimTo: "support@ascii.dev",
  subject: "EACbot introduced me: $50 Boat credit",
  body: "Hi Boat team,\n\nEACbot introduced me to Boat. I'm on the $___ plan.\nMy Boat account email: ___\n\nThanks!",
  until: null,
};

/** Whether the offer shows anywhere. This build does not promote Boat, so it never does; the copy and the claim link
 * stay here for a fork that wants them, and every caller reads this one answer instead of deciding for itself. */
export function boatOfferRuns(_now: number, _offer: BoatOffer = BOAT_OFFER): boolean {
  return false;
}

/** RFC 6068: everything after the address is percent-encoded (never "+" for a space) and a line break is %0D%0A. */
export function boatClaimMailto(offer: BoatOffer = BOAT_OFFER): string {
  const encode = (text: string) => encodeURIComponent(text.replace(/\r?\n/g, "\r\n"));
  return `mailto:${offer.claimTo}?subject=${encode(offer.subject)}&body=${encode(offer.body)}`;
}
