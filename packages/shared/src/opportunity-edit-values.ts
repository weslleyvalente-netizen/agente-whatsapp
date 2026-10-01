const FALLBACK_FIELDS=new Set(["product_model","sale_amount","credit_amount","down_payment_amount","bid_amount","target_installment_amount","term_months","usage_purpose","urgency","commercial_notes","next_action"]);
export function resolveOpportunityEditValues(opportunity:Record<string,unknown>,qualification:Record<string,unknown>|null):Record<string,unknown>{
 const expected:Record<string,string>={vehicle_sale:"cash",consortium:"consortium",financing:"financing"};
 const compatible=!opportunity.operation || !!expected[String(opportunity.operation)] && qualification?.attendance_type===expected[String(opportunity.operation)];
 const contextual=new Set(["product_model","usage_purpose","urgency"]);
 return Object.fromEntries(Object.entries(opportunity).map(([key,value])=>[key,FALLBACK_FIELDS.has(key) && (compatible || contextual.has(key)) ? value ?? qualification?.[key] ?? null : value]));
}
