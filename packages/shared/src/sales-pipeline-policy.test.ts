import {it,expect} from "vitest";
import {decideSalesPipeline as decide} from "./sales-pipeline-policy.js";
it("não inventa operação a partir de cumprimento",()=>{expect(decide({customerText:"oi",qualification:null})).toBeNull()});
it("identifica interesse explícito e qualifica só com informação comercial",()=>{
 expect(decide({customerText:"Quero consórcio",qualification:null})).toMatchObject({operation:"consortium",stage:"interest_received",explicitOperation:true});
 expect(decide({customerText:"Quero consórcio da Fazer",qualification:{product_model:"Fazer",target_installment_amount:500}})).toMatchObject({stage:"qualification"});
});
it("preço no cadastro não prova apresentação",()=>{
 expect(decide({customerText:"Quero LiberaCred",qualification:{product_model:"Factor",sale_amount:10000,term_months:12},agentText:"Vou verificar as condições"})).toMatchObject({stage:"qualification"});
 expect(decide({customerText:"Quero LiberaCred",qualification:{product_model:"Factor",target_installment_amount:500,term_months:12},agentText:"O plano é de 12x com parcela de R$ 500,00."})).toMatchObject({stage:"plan_term_presented"});
});
it("negociação preserva modalidade e não marca ganho",()=>{
 expect(decide({customerText:"Quero fechar",qualification:null,operation:"consortium"})).toMatchObject({stage:"decision_negotiation",explicitOperation:false});
});
it("não escolhe entre modalidades contraditórias",()=>{expect(decide({customerText:"consórcio ou financiamento",qualification:null})).toBeNull()});

it("não cria novo interesse após recusa explícita",()=>{expect(decide({customerText:"Não tenho mais interesse",qualification:{attendance_type:"consortium",product_model:"Fazer"}})).toBeNull()});

it("não troca modalidade explicitamente recusada",()=>{expect(decide({customerText:"Não quero financiamento",operation:"vehicle_sale",qualification:null})).toBeNull()});
it("não considera oferta indisponível como proposta",()=>{expect(decide({customerText:"Quero consórcio",qualification:{product_model:"Fazer",target_installment_amount:500,term_months:12},agentText:"Não temos plano de 12 parcelas por R$ 500,00."})?.stage).toBe("qualification")});

it("pergunta de orçamento não equivale a uma proposta",()=>{expect(decide({customerText:"Quero consórcio",qualification:{product_model:"Fazer",target_installment_amount:500,term_months:12},agentText:"Você quer um plano de 12 parcelas por R$ 500,00?"})?.stage).toBe("qualification")});

it('routes a complete financing handoff to simulation even after a short acknowledgment',()=>{
 expect(decide({customerText:'Ok',humanHandoff:true,qualification:{attendance_type:'financing',product_model:'CG160 Titan',cpf_encrypted:'encrypted',birth_date:'1990-01-01',has_driver_license:true,down_payment_amount:3000}})).toMatchObject({operation:'financing',stage:'awaiting_simulation'});
});
it('keeps incomplete financing in documentation without inventing bank results',()=>{
 expect(decide({customerText:'Quero financiar',humanHandoff:true,qualification:{attendance_type:'financing',product_model:'CG160 Titan',down_payment_amount:0}})).toMatchObject({stage:'documentation'});
});
