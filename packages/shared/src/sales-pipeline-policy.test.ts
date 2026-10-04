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

it("identifica moto elétrica sem escolha definitiva",()=>{expect(decide({customerText:"Ta quanto a moto elétrica",qualification:null})).toMatchObject({operation:"vehicle_sale",stage:"interest_received"})});
it("aproveita histórico após resposta curta",()=>{expect(decide({customerText:"Valor",customerHistory:["Ta quanto a moto elétrica","Vc tem a x13 pro","Ta"],qualification:null})).toMatchObject({operation:"vehicle_sale",stage:"interest_received"})});
it("não ressuscita recusa ou resolve ambiguidade",()=>{
 expect(decide({customerText:"oi",customerHistory:["Quero bike","Não tenho mais interesse"],qualification:null})).toBeNull();
 expect(decide({customerText:"Ok",customerHistory:["Quero bike","consórcio ou financiamento"],qualification:null})).toBeNull();
});
it("prioriza modalidade atual",()=>{expect(decide({customerText:"Quero consórcio",customerHistory:["Quero bike"],qualification:null})).toMatchObject({operation:"consortium"})});


it('recovers Alessandro interest with a short noisy suffix after neutral replies',()=>{
 expect(decide({customerText:'🤷‍♂️',customerHistory:['Tenho interesse em consórciobaadae','Moto'],qualification:null})).toMatchObject({operation:'consortium',stage:'interest_received',explicitOperation:false});
});
it.each(['consórciobaadae','Não quero consórciobaadae','Nem consórciobaadae','Tenho interesse em consórciobaadae ou financiamento','Tenho interesse em consorciologia'])('does not manufacture interest from %s',text=>{
 expect(decide({customerText:'Ok',customerHistory:['Quero bike',text],qualification:null})).toBeNull();
});
it.each([
 ['vehicle_sale','negotiation'],['consortium','decision_negotiation'],['libera_cred','decision_objections'],['contemplated_letter','compatible_letter_search'],
] as const)('routes a verified commercial handoff for %s without inventing financial outcomes',(operation,stage)=>{
 for(const humanHandoffMotive of ['negociacao_valor','proposta_pronta','cliente_pediu'])
  expect(decide({customerText:'Ok',operation,qualification:null,humanHandoff:true,humanHandoffMotive})).toMatchObject({operation,stage});
});
it('requires a pending handoff and a supported commercial motive',()=>{
 for(const handoff of [{humanHandoff:false,humanHandoffMotive:'proposta_pronta'},{humanHandoff:true,humanHandoffMotive:'reclamacao'},{humanHandoff:true}])
  expect(decide({customerText:'Ok',operation:'consortium',qualification:null,...handoff})).toMatchObject({stage:'interest_received'});
 expect(decide({customerText:'Ok',qualification:null,humanHandoff:true,humanHandoffMotive:'cliente_pediu'})).toBeNull();
 expect(decide({customerText:'Não tenho mais interesse',operation:'consortium',qualification:null,humanHandoff:true,humanHandoffMotive:'proposta_pronta'})).toBeNull();
});
it('keeps an evidenced contemplated letter proposal when handing off',()=>{
 expect(decide({customerText:'Ok',operation:'contemplated_letter',qualification:{credit_amount:10000},agentText:'A carta custa R$ 10.000,00.',humanHandoff:true,humanHandoffMotive:'proposta_pronta'})).toMatchObject({stage:'proposal_sent'});
});
