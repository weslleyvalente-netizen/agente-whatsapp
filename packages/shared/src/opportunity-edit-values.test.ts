import { it,expect } from "vitest";
import { resolveOpportunityEditValues } from "./opportunity-edit-values.js";
it("pré-preenche campos ausentes da oportunidade, preservando zero e divergências",()=>{
 expect(resolveOpportunityEditValues({product_model:null,down_payment_amount:0,target_installment_amount:100},{product_model:"Yamaha Fazer",down_payment_amount:500,target_installment_amount:200,cpf:"123"})).toEqual({product_model:"Yamaha Fazer",down_payment_amount:0,target_installment_amount:100});
});

it("não recupera condições de consórcio em LiberaCred",()=>{expect(resolveOpportunityEditValues({operation:"libera_cred",credit_amount:null,term_months:null,commercial_notes:null},{attendance_type:"consortium",credit_amount:30000,term_months:80,commercial_notes:"Consórcio 80x"})).toEqual({operation:"libera_cred",credit_amount:null,term_months:null,commercial_notes:null})});
