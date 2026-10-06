import {isSubstantiveCustomerMessage} from "./sales-workspace.js";

const EARLY_STAGES = ["interest_received", "qualification"];

export interface StalledNegotiationEvidence {
 /** Contents of the customer's messages in the conversation (any order). */
 customerMessages: string[];
 humanMessageCount: number;
 openOpportunityStages: string[];
}

/**
 * A priced conversation (sale_amount in the qualification) only deserves a
 * human alert when the customer really engaged (2+ substantive messages, ad
 * click text excluded) AND the deal moved past the first stages or a human
 * already attended it. A price the AI merely collected, for a lead that never
 * advanced, is not a stalled negotiation.
 */
export function shouldAlertStalledNegotiation(e: StalledNegotiationEvidence): boolean {
 const engaged = e.customerMessages.filter(m => isSubstantiveCustomerMessage(m)).length >= 2;
 if (!engaged) return false;
 const advanced = e.openOpportunityStages.some(s => !EARLY_STAGES.includes(s));
 return advanced || e.humanMessageCount > 0;
}
