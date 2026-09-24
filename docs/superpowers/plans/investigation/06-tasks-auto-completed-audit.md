# Auditoria — tarefas possivelmente concluídas indevidamente (bug de auto-complete no takeover)

Total: 557 tarefas com status completed cujo completed_at cai dentro de 120s do primeiro takeover humano na conversa.

**NÃO REABRIR EM MASSA.** Esta é uma lista pra revisão humana — algumas podem ter sido genuinamente resolvidas nesses segundos (ex. tarefa trivial). Confiança alta (≤15s) é a maioria; 15-120s é confiança média.

| task_id | conversation_id | tipo | contato | completed_at | segundos após takeover |
|---|---|---|---|---|---|
| 0d2321fd-2458-4de0-a288-b48d6319997b | 74c61c0b-7de2-4a49-ae1a-701c5f8d7ac6 | return_customer | María Lopes | 2026-09-19 12:31:11.789+00 | 0.1 |
| c8a35c33-5f2a-47dd-a8a9-4ad12cfa81ed | 33e712b8-1855-427a-90d5-e3e7e531cd37 | return_customer | Andrelival | 2026-09-16 13:19:06.733+00 | 0.1 |
| 5a3ff53b-454f-4262-8aaa-5fcc5a4bbf3f | 498a6fe5-cc08-46f4-9c44-4bceccc02db6 | financing_followup | Carleones Martins Filho | 2026-09-21 14:30:06.613+00 | 0.1 |
| a823cd5c-d2a0-4958-868c-ef781cafcaca | 153dd68a-0c96-4a71-9ee2-e68cae2e286a | consortium_followup | Maria Bezerra | 2026-09-22 19:36:50.739+00 | 0.1 |
| a7ad7c12-7233-40bc-a3bc-a60b7d2a4b86 | 6c8a43dc-e93a-41ab-a361-1b7b904d7b16 | customer_unresponsive | Guilherme Rotilli | 2026-09-22 20:00:28.394+00 | 0.1 |
| d37c3185-bc42-4c57-a4fc-c9ec3c7a59af | 47ac54aa-6474-4f3c-b4a3-4926174cf7e8 | other | didi | 2026-09-18 13:19:49.108+00 | 0.1 |
| be9719f0-c57f-4989-94ee-601d165c08f7 | 71975af6-023f-4eaa-937e-59a99a48de42 | return_customer | Carlos 🫶 | 2026-09-16 13:07:48.209+00 | 0.1 |
| 1a6f7522-ca9c-4f07-aae4-d16ac9244a82 | 33e712b8-1855-427a-90d5-e3e7e531cd37 | run_quote | Andrelival | 2026-09-16 13:19:06.732+00 | 0.1 |
| 155629b1-de57-46e9-b42f-12a580341cb9 | 04bc522f-2fe1-4e16-9b6a-0350911cf85e | return_customer | Raquel | 2026-09-18 13:29:54.205+00 | 0.1 |
| 0c153c2d-3746-49cc-a1b6-f030fd4bf5a6 | 8c5f5c2c-f1be-46f9-9bc2-cc67608c816b | customer_unresponsive | 61998014519 | 2026-09-16 13:37:02.346+00 | 0.1 |
| c307cd3a-895b-4d36-ba8e-c8580b834e2e | 47ac54aa-6474-4f3c-b4a3-4926174cf7e8 | proposal_followup | didi | 2026-09-18 13:19:49.108+00 | 0.1 |
| fa705c3f-c962-442c-bbc2-2a58eebb4af4 | 48b9a4cb-9854-4f26-801d-913e6cc67126 | return_customer | Damasceno | 2026-09-18 13:31:35.593+00 | 0.1 |
| 48d7b045-2f88-42f8-8c65-f3255628b334 | 418deded-edd4-4bcb-b8b7-5f60fc7287b8 | return_customer | Jerres Sousa | 2026-09-21 13:04:56.727+00 | 0.1 |
| c062bf2d-9fac-4166-a3fe-6e9a93276e98 | 0b0acaca-3caa-4fe0-ad07-774cdf3267f4 | consortium_followup | #Soldadopdc 🪖🫡🚧 | 2026-09-16 13:21:05.144+00 | 0.1 |
| 719d5ae4-ae71-4026-aa8b-89c17149ede2 | 0b0acaca-3caa-4fe0-ad07-774cdf3267f4 | run_quote | #Soldadopdc 🪖🫡🚧 | 2026-09-16 13:21:05.144+00 | 0.1 |
| 593f538a-6288-4f6e-885d-c63bad16b5ff | 6649ab42-1111-4cf3-a872-1871d67077de | customer_unresponsive | Luciene | 2026-09-22 20:19:58.906+00 | 0.1 |
| 454fe5bc-05d2-4c2b-8500-d1b6c9553dfc | 8c5f5c2c-f1be-46f9-9bc2-cc67608c816b | return_customer | 61998014519 | 2026-09-16 13:37:02.346+00 | 0.1 |
| 6d9644fa-630f-41f9-9f3e-f6a3bede41bd | da2faa1c-3bfd-426e-90ba-87669cbadec4 | run_quote | marcos | 2026-09-22 20:41:25.301+00 | 0.1 |
| 317d6b67-3c7a-4e31-9ec7-314adac82c30 | da2faa1c-3bfd-426e-90ba-87669cbadec4 | financing_followup | marcos | 2026-09-22 20:41:25.301+00 | 0.1 |
| 3c0ce923-3cb9-4c7b-bdbb-0d6edf488a8e | 8e4872c0-c6d4-4bc6-a409-7b9a312df64b | customer_unresponsive | Flavio | 2026-09-16 13:58:44.795+00 | 0.1 |
| c3d01be4-6f7d-4183-85fc-6b051f7c7645 | 281e6622-b5f1-4b89-a234-aba403c919d3 | return_customer | Ailton Gomes 👾 | 2026-09-16 20:50:21.689+00 | 0.1 |
| 96c4bb4f-61fa-447d-8757-f35f9c3203a3 | 05ff3f16-9f77-47b4-b423-e096442bfddc | consortium_followup | Rafael Rodrigues | 2026-09-16 13:42:36.278+00 | 0.1 |
| f2f45dca-f788-4d6e-916e-816db981e66b | 8e4872c0-c6d4-4bc6-a409-7b9a312df64b | return_customer | Flavio | 2026-09-16 13:58:44.795+00 | 0.1 |
| 1d62e194-13cc-4781-9272-44fc2ad3c14d | 8e4872c0-c6d4-4bc6-a409-7b9a312df64b | run_quote | Flavio | 2026-09-16 13:58:44.794+00 | 0.1 |
| fc9b2e1b-ea2b-43b7-818c-2cdd91fdb3e9 | 8e4872c0-c6d4-4bc6-a409-7b9a312df64b | financing_followup | Flavio | 2026-09-16 13:58:44.795+00 | 0.1 |
| e79059f8-559a-4567-853f-25c95c1010b1 | 51f5733d-ede1-463b-ab48-73393df8c929 | financing_followup | Gui | 2026-09-16 15:31:10.024+00 | 0.1 |
| 42133396-c2f6-4dfd-a562-5d98a93bacaa | 51f5733d-ede1-463b-ab48-73393df8c929 | run_quote | Gui | 2026-09-16 15:31:10.024+00 | 0.1 |
| d402f4c0-108c-4081-a31f-4739c7295c61 | 44b37362-330e-4ba4-9f5d-9c5d9eecf268 | customer_unresponsive | Inês | 2026-09-16 21:04:11.91+00 | 0.1 |
| 8c469a3d-805a-47fe-9b75-b80437db1055 | 55619574-a3a2-4472-8cfd-151c69639bb4 | vehicle_followup | Samuel Santos. | 2026-09-17 20:16:13.623+00 | 0.1 |
| d6846626-9c77-44bb-8fb7-6ef8059d338d | 8f71fb23-9b21-4116-ac16-5098d85a9aa2 | financing_followup | Mk | 2026-09-16 20:49:37.67+00 | 0.1 |
| 47b3b630-3f8b-43b8-b2b6-4fa895e1b6fd | 4eaf8f1c-f858-44cc-addf-3533d65f8c96 | run_quote | vicente munoz 🇧🇷🇪🇦 | 2026-09-16 18:45:30.471+00 | 0.1 |
| 18fd239f-745d-45ee-ac36-61fb80bc38e0 | 4eaf8f1c-f858-44cc-addf-3533d65f8c96 | financing_followup | vicente munoz 🇧🇷🇪🇦 | 2026-09-16 18:45:30.471+00 | 0.1 |
| d1fa517d-adaa-4052-9b20-6276bcef16b7 | 8f71fb23-9b21-4116-ac16-5098d85a9aa2 | run_quote | Mk | 2026-09-16 20:49:37.67+00 | 0.1 |
| e08ca342-2211-469e-ab9d-8c7dedcf69db | ab67603f-cf91-4e8f-a3a6-4b6096c6b72b | customer_unresponsive | Maria Neide | 2026-09-18 13:53:20.933+00 | 0.1 |
| e7fe1b4b-2163-49fa-a78a-21aa93f61761 | 44b37362-330e-4ba4-9f5d-9c5d9eecf268 | return_customer | Inês | 2026-09-16 21:04:11.91+00 | 0.1 |
| 0a6ed989-9402-4c96-9aa4-bc060243d9d0 | 38078e24-4529-41ba-9382-9558cf13a29f | proposal_followup | Luciano | 2026-09-16 18:05:46.046+00 | 0.1 |
| d51a2347-a631-4ffb-9be2-7fa006f0a68c | 13e9c641-4b31-4a17-8d1a-b1f34fd51bf0 | return_customer | ... | 2026-09-16 18:14:17.719+00 | 0.1 |
| 2fb684d7-b30e-48ca-8177-83fae64b8487 | 9028f41f-c7e9-4fae-8d39-cfb6ab4262c4 | proposal_followup | Evandro Estefano | 2026-09-16 21:05:46.815+00 | 0.1 |
| c22da151-1a43-4e68-8b3b-a10396f5e964 | 03faec6d-8cfc-49bd-b5a6-8d934cb682ad | return_customer | Marcos | 2026-09-17 13:58:29.697+00 | 0.1 |
| b6c0b2c5-1fca-4010-abb5-73397940a445 | 9fa54361-1e2f-4e50-bc1a-bf2558619216 | run_quote | Andreia Sofia | 2026-09-22 11:38:34.991+00 | 0.1 |
| c6d40f4e-86e9-43bf-a0b8-d27c13f933a1 | 68f5c249-1600-4f80-953e-ff980ceecfe8 | customer_unresponsive | João Paulo | 2026-09-17 14:18:54.534+00 | 0.1 |
| 19acacfe-a886-46ca-8149-a8af81974751 | 9f7f735e-c7e3-43f3-ad9f-226610770a31 | return_customer | Deus Mim Abençoe 🙌🙏 | 2026-09-22 12:42:55.085+00 | 0.1 |
| a3d46c1e-d20d-4cb0-8723-5bb98107f06b | 281e6622-b5f1-4b89-a234-aba403c919d3 | customer_unresponsive | Ailton Gomes 👾 | 2026-09-16 20:50:21.689+00 | 0.1 |
| 7fe47958-6885-48bf-8ca3-db70b442e798 | 9028f41f-c7e9-4fae-8d39-cfb6ab4262c4 | return_customer | Evandro Estefano | 2026-09-16 21:05:46.815+00 | 0.1 |
| ce0d7a2e-5c0b-47cd-b9d0-1bacdf84088d | 9028f41f-c7e9-4fae-8d39-cfb6ab4262c4 | customer_unresponsive | Evandro Estefano | 2026-09-16 21:05:46.815+00 | 0.1 |
| 130d9c57-21bd-419f-878d-c0024a7e7921 | c4256864-51e0-4685-b1e5-392689b7187f | run_quote | Binho | 2026-09-17 20:29:24.191+00 | 0.1 |
| 110d0643-dc5b-4a19-a8ae-e7580abf01ff | 043d9a95-d934-4aa1-a9f1-fd1052d30eed | customer_unresponsive | Cleiton Cavalcante 👊🏼 | 2026-09-17 14:29:46.085+00 | 0.1 |
| f13238b2-2741-4f7c-b0a3-f0b6618e1cce | e147e0f1-cd84-41d5-b0cd-3bf801061180 | return_customer | RezaBraba😎🏄🏾‍♂️🤞🏾 | 2026-09-18 13:03:23.012+00 | 0.1 |
| 8d83530e-06f3-41aa-a1ac-55ff8177a42f | 60dcf6ba-9776-48d2-815f-4423bdae2e67 | customer_unresponsive | Alecrim | 2026-09-22 12:35:18.59+00 | 0.1 |
| 4b447ac5-a33e-4577-bd4d-00cebcb47fda | 694668b5-fcb4-4bd0-beb3-2c4926aff9a3 | customer_unresponsive | . | 2026-09-18 14:10:02.633+00 | 0.1 |
| a1125440-801a-46e0-ac8e-ee668ebea6ff | b2addfa8-c11b-4b2c-b28e-b57b7430a3fa | proposal_followup | 😎 | 2026-09-17 14:13:59.891+00 | 0.1 |
| 16b1c291-1f38-46d6-87c2-a470416262b4 | 77696d3a-f832-4d59-a559-2b82235f811b | customer_unresponsive | Antonio Cardoso Pereira | 2026-09-21 20:01:17.997+00 | 0.1 |
| e424344f-7daa-40d1-a6ca-046021070609 | 4151a0cd-3019-46e9-aad8-4f2d4f906be9 | financing_followup | Alex Almeida | 2026-09-17 15:00:34.126+00 | 0.1 |
| a8d488a2-33ab-44f5-9925-ec11b22f9495 | 1b3929a1-7204-4410-a119-2ae4998bab5f | return_customer | Mariana | 2026-09-17 15:02:54.307+00 | 0.1 |
| 153d83d4-fbad-4500-bc40-a90394661fb7 | 1b3929a1-7204-4410-a119-2ae4998bab5f | customer_unresponsive | Mariana | 2026-09-17 15:02:54.307+00 | 0.1 |
| f2f64cf3-870d-4a87-916d-6b69a93030b7 | ca23a812-9cba-41c6-968f-185f61403cf5 | return_customer | elivan93269802 | 2026-09-17 15:03:05.181+00 | 0.1 |
| b54e1303-64f9-4fbd-8a74-193c237ae759 | ca23a812-9cba-41c6-968f-185f61403cf5 | customer_unresponsive | elivan93269802 | 2026-09-17 15:03:05.181+00 | 0.1 |
| 147d0eb0-4502-4116-8132-77eabda44530 | e89396ef-6689-4d69-b7be-e22f64e9ee55 | return_customer | Luiz 🛠️⚙️🛠️ | 2026-09-17 15:03:54.937+00 | 0.1 |
| 5f4c93d4-3186-459b-b806-bc60ddc597af | e89396ef-6689-4d69-b7be-e22f64e9ee55 | customer_unresponsive | Luiz 🛠️⚙️🛠️ | 2026-09-17 15:03:54.937+00 | 0.1 |
| dc98f090-779b-4dfa-9e47-f9ea6b0e007b | 55619574-a3a2-4472-8cfd-151c69639bb4 | financing_followup | Samuel Santos. | 2026-09-17 20:16:13.623+00 | 0.1 |
| f0ea70d9-7613-41d7-9cfc-b83713d7a6a6 | ae641dcd-3123-4a86-947f-b55c15574555 | consortium_followup | Luh💘 | 2026-09-18 13:01:30.798+00 | 0.1 |
| e774812e-6ad8-4cca-83cf-b824b8065d44 | 2cac2c12-cd88-4a40-9536-4b782d85bb8f | customer_unresponsive | Flávio | 2026-09-18 14:23:34.363+00 | 0.1 |
| 9d9b5f3a-6594-411e-8f6a-14d3fb0a6450 | 2cac2c12-cd88-4a40-9536-4b782d85bb8f | return_customer | Flávio | 2026-09-18 14:23:34.363+00 | 0.1 |
| 9a873ff1-8db3-4bdb-a581-38233c450adc | 054ffd6a-12c5-46c8-b7e5-3fb91a1c65c6 | financing_followup | hemilly | 2026-09-21 14:53:00.961+00 | 0.1 |
| e0ef6afd-5c1f-4de0-9acc-919a98b86943 | 4bcb5b9a-65e7-4abe-bca7-6659230e9eb6 | run_quote | Vitor Eduardo | 2026-09-22 12:43:42.357+00 | 0.1 |
| 7caa9f99-19b6-4971-929d-595c07974321 | c79f165a-79e8-4502-91bd-de665e9eb2b5 | customer_unresponsive | gildasio | 2026-09-17 15:06:02.401+00 | 0.1 |
| 77bb7ecd-c289-4767-b2e8-3dd842e5bd23 | c79f165a-79e8-4502-91bd-de665e9eb2b5 | other | gildasio | 2026-09-17 15:06:02.401+00 | 0.1 |
| cd576fbe-f5dc-48ab-ad8b-332e9783bc8a | c79f165a-79e8-4502-91bd-de665e9eb2b5 | vehicle_followup | gildasio | 2026-09-17 15:06:02.401+00 | 0.1 |
| 4fc0b447-97b0-4191-b674-65b3f3cb7e47 | c79f165a-79e8-4502-91bd-de665e9eb2b5 | return_customer | gildasio | 2026-09-17 15:06:02.401+00 | 0.1 |
| fdaf0a69-2f1c-4361-880f-b315c183dce6 | f71ae171-9bfb-4cf2-ad68-eee35e252645 | consortium_followup | valdomirodesouzaaguiar8 | 2026-09-17 15:31:26.543+00 | 0.1 |
| 731b9736-9583-4b92-af45-9b11da5e1898 | c3d7e6ab-5a46-4979-a299-5c34f1afdfbb | return_customer | dionisionm123 | 2026-09-17 20:25:06.344+00 | 0.1 |
| fb1af19d-0fde-46f4-b271-f87bfc9fb4ca | 2cac2c12-cd88-4a40-9536-4b782d85bb8f | consortium_followup | Flávio | 2026-09-18 14:23:34.363+00 | 0.1 |
| 53ac3953-1924-4666-838b-acee3a68ae29 | 99224ed6-33a3-49e1-ab1c-4c4105302a35 | return_customer | Maria Flora | 2026-09-21 20:06:52.566+00 | 0.1 |
| b21c7a5f-1807-44c7-ab72-6dfb84e40b95 | 99224ed6-33a3-49e1-ab1c-4c4105302a35 | customer_unresponsive | Maria Flora | 2026-09-21 20:06:52.566+00 | 0.1 |
| f662833e-b0ff-4bab-bff0-ee62ddd94800 | b2addfa8-c11b-4b2c-b28e-b57b7430a3fa | customer_unresponsive | 😎 | 2026-09-17 14:13:59.891+00 | 0.1 |
| d5ca43cc-a529-4ed1-bc4e-0c6fdbeb095d | 64486066-3f6c-47ea-ae8b-abfd288e34e0 | financing_followup | Ghabrielly | 2026-09-17 14:23:19.376+00 | 0.1 |
| 4347e843-0684-4bcf-b3c5-41f885cbb23f | be5fda73-a738-4bb4-a4f1-ef8c3da22530 | financing_followup | .. | 2026-09-17 20:13:55.544+00 | 0.1 |
| aaa268bc-bc05-4495-8fb4-b4975e4a213e | be5fda73-a738-4bb4-a4f1-ef8c3da22530 | run_quote | .. | 2026-09-17 20:13:55.544+00 | 0.1 |
| 5db0bd09-2f8d-4e5a-8440-4116d358964f | 55619574-a3a2-4472-8cfd-151c69639bb4 | other | Samuel Santos. | 2026-09-17 20:16:13.623+00 | 0.1 |
| c9445500-9381-486a-87d2-350b2879b13d | 55619574-a3a2-4472-8cfd-151c69639bb4 | return_customer | Samuel Santos. | 2026-09-17 20:16:13.623+00 | 0.1 |
| fadae8a7-82ea-468d-acdb-2eef9f1269ce | 55619574-a3a2-4472-8cfd-151c69639bb4 | run_quote | Samuel Santos. | 2026-09-17 20:16:13.623+00 | 0.1 |
| 151269b9-24db-4e30-8e64-d412ea39137a | c3d7e6ab-5a46-4979-a299-5c34f1afdfbb | customer_unresponsive | dionisionm123 | 2026-09-17 20:25:06.344+00 | 0.1 |
| 607a7342-da3f-44bc-8a12-f35ca45471f8 | 6e495adf-950f-4b4c-adf7-758710f47d21 | customer_unresponsive | Elias | 2026-09-18 14:00:27.844+00 | 0.1 |
| 7089362f-ee9a-4be9-907e-121e5e6276b0 | 6e495adf-950f-4b4c-adf7-758710f47d21 | financing_followup | Elias | 2026-09-18 14:00:27.844+00 | 0.1 |
| a1a9f73b-75f6-4475-aafb-d16a54b1c6a5 | 83ce5fd4-bbfc-43b8-b0a6-cf7d4ab0e651 | proposal_followup | Francklin Vasconcelos | 2026-09-21 15:25:33.244+00 | 0.1 |
| 430786bd-1dad-42a5-acdb-0441c9eb8246 | 6e495adf-950f-4b4c-adf7-758710f47d21 | consortium_followup | Elias | 2026-09-18 14:00:27.843+00 | 0.1 |
| f3d48150-291c-49b0-8ef8-fad84e3ce813 | e147e0f1-cd84-41d5-b0cd-3bf801061180 | consortium_followup | RezaBraba😎🏄🏾‍♂️🤞🏾 | 2026-09-18 13:03:23.012+00 | 0.1 |
| 9ae6c58b-43a1-4ccb-88a9-b3c5d8ac6169 | 694668b5-fcb4-4bd0-beb3-2c4926aff9a3 | consortium_followup | . | 2026-09-18 14:10:02.633+00 | 0.1 |
| a882f5ea-798f-44b5-989d-399afcbc5340 | 4331d87a-666d-4743-91a9-24614b6bd298 | consortium_followup | bernardobuenoalexandre6 | 2026-09-22 12:47:05.08+00 | 0.1 |
| 87960713-406c-40f7-b461-9e510228775f | 41ea4bf4-4fa4-4cb2-9ced-ae8cd39d31d4 | customer_unresponsive | Johnny | 2026-09-22 13:39:38.087+00 | 0.1 |
| ba27db2a-9d2e-48a4-869f-66cc852cf08d | 6dcac45c-aa98-43c6-bfa5-fd0dc65a286c | customer_unresponsive | Romiro | 2026-09-22 13:39:57.27+00 | 0.1 |
| bf091d48-d8ef-42f8-85ff-758858192f56 | 1ca86a7e-6afb-4f34-87f5-f5b09bb351cc | vehicle_followup | Eu E Ele.meu Amor ❤️❤️🙏 | 2026-09-18 14:01:36.301+00 | 0.1 |
| 5943ba9c-694e-4849-8517-8a040ab27933 | c7b764fd-70e7-459e-8c23-c359a0120120 | other | Mazim | 2026-09-18 14:06:41.696+00 | 0.1 |
| 9581b2dc-a867-4082-a629-1e1beccca962 | 2cd1c12a-7480-4ea2-9e47-a327488b3de1 | customer_unresponsive | Wanderley | 2026-09-22 12:41:37.5+00 | 0.1 |
| 487db202-79f2-4dca-a374-2eed10728421 | 6dcac45c-aa98-43c6-bfa5-fd0dc65a286c | return_customer | Romiro | 2026-09-22 13:39:57.27+00 | 0.1 |
| d880a20a-00af-4c43-81ce-63aa13ea8f94 | 8ce7b3fe-8e45-40ce-9910-dcf4a1e6111e | customer_unresponsive | vania | 2026-09-22 14:04:35.582+00 | 0.1 |
| c0f459a8-3ac7-45c9-9957-9169a80421ea | 8ce7b3fe-8e45-40ce-9910-dcf4a1e6111e | vehicle_followup | vania | 2026-09-22 14:04:35.582+00 | 0.1 |
| 275de146-fa5a-4531-b162-2920d6648bed | 73a381f4-e917-4690-9534-23cd6c682bea | return_customer | Jeffersonsabath Je | 2026-09-18 14:25:44.458+00 | 0.1 |
| 3c226428-1216-42ac-aa43-1a0ca67f4bcc | 73a381f4-e917-4690-9534-23cd6c682bea | customer_unresponsive | Jeffersonsabath Je | 2026-09-18 14:25:44.458+00 | 0.1 |
| ed1b589a-fa99-4369-86b4-fea1e1be10bf | ecf73412-6dbf-48c9-9afc-1488df8c12c3 | customer_unresponsive | Israel | 2026-09-21 15:33:47.861+00 | 0.1 |
| 5d9507f5-bef7-4e17-ae55-2fb93967f7df | 6d5e145e-2e00-441b-82b9-fb6bc8328574 | financing_followup | C | 2026-09-22 12:41:19.026+00 | 0.1 |
| d47730ec-3252-419f-8ed5-9076c8bddf61 | 3d500cd9-8d26-44d3-b12d-a6ac898d10b0 | return_customer | elimar | 2026-09-22 12:42:03.865+00 | 0.1 |
| 3a617aa1-cdbe-4feb-9a34-2dc9c1c21eb3 | 9e6b2d60-0ab3-4d3a-b619-2ca3be89ac7e | consortium_followup | 😎 | 2026-09-18 15:20:16.55+00 | 0.1 |
| db0eedc9-38fe-4cf9-aa29-3a683b761fc1 | fb74d1c1-6134-4910-8d6e-08c591cb3e4c | run_quote | 💐💐🥰😘💐💐💐 | 2026-09-18 18:36:56.608+00 | 0.1 |
| 7bf33b75-9c0f-4180-baac-c69c300a7434 | fb74d1c1-6134-4910-8d6e-08c591cb3e4c | financing_followup | 💐💐🥰😘💐💐💐 | 2026-09-18 18:36:56.608+00 | 0.1 |
| 8c3d5a4c-15c8-4173-abb6-a152356d3f8d | 3647411d-c033-4ed5-9369-ae57e5ee045e | consortium_followup | Alany P. F | 2026-09-18 18:17:28.422+00 | 0.1 |
| 3501d591-d63e-49ad-9753-aca5bd583d59 | 077d4840-84dd-4315-af95-7c1c04841d97 | other | Ph | 2026-09-18 18:56:43.934+00 | 0.1 |
| 53414a10-5e16-42d6-9992-9f64856233bf | 6abdfe59-2683-4b8b-9972-b8d48529884e | vehicle_followup | Alexandre Soares | 2026-09-18 18:57:10.113+00 | 0.1 |
| c3c8d897-576f-4202-8efa-7d97269f3514 | aeef4d36-28f0-40d7-9299-816775653f66 | customer_unresponsive | 𝓚𝓪𝓾𝓪̃ 𝓖𝓾𝓼𝓽𝓪𝓿𝓸 | 2026-09-18 19:51:03.538+00 | 0.1 |
| 93afc0f3-63b0-4529-a158-c8a03cae9fa9 | fb9a856b-0ffe-406b-bcbc-6886f90c7a90 | customer_unresponsive | rose | 2026-09-18 20:22:24.446+00 | 0.1 |
| 2570da93-9441-45f3-a6b6-426e106dad76 | db3cd270-20e7-411d-a5d0-7287f4c90de5 | customer_unresponsive | Nubia | 2026-09-21 20:34:12.002+00 | 0.1 |
| 2df574c6-7127-4ffa-8ffe-3deb3527743a | a5348ce1-f23a-45ad-9545-ef0518074e31 | other | Alisson S. | 2026-09-19 13:31:17.763+00 | 0.1 |
| 53f44b5d-de7e-4a44-9501-bd21352316b8 | 0ed23ecb-46ea-462e-8370-c948bb15b955 | customer_unresponsive | Vando | 2026-09-19 13:45:24.165+00 | 0.1 |
| 68058868-1a72-4589-a2e2-30a4cacbb034 | 91bffbeb-a2e2-459a-bd9c-bfcf3995dbe9 | run_quote | ᖴᗩTIᗰᗩ ᗩᒪᐯEᔕ | 2026-09-19 12:30:27.32+00 | 0.1 |
| 49688ef0-c39a-453b-b20c-e1aa1a1f37d1 | 74c61c0b-7de2-4a49-ae1a-701c5f8d7ac6 | customer_unresponsive | María Lopes | 2026-09-19 12:31:11.789+00 | 0.1 |
| 8522377a-3bf9-4f71-b990-6721897a7d1e | 0ed23ecb-46ea-462e-8370-c948bb15b955 | run_quote | Vando | 2026-09-19 13:45:24.165+00 | 0.1 |
| 2600d946-0af3-4516-8479-8c72a65e9a0d | 465f817b-0df8-4ee5-9616-879df13fbc5e | customer_unresponsive | Wilson Da Silva Claudino | 2026-09-19 13:29:51.031+00 | 0.1 |
| b25ad976-acc5-4f23-aba7-1e3f5080d6b0 | 465f817b-0df8-4ee5-9616-879df13fbc5e | return_customer | Wilson Da Silva Claudino | 2026-09-19 13:29:51.031+00 | 0.1 |
| 879a8ef9-858e-4038-a421-fcd9510097de | a5348ce1-f23a-45ad-9545-ef0518074e31 | consortium_followup | Alisson S. | 2026-09-19 13:31:17.763+00 | 0.1 |
| 57cecf36-d700-4276-8e92-d7a26f78ae98 | 1cf4e4f3-7782-47a6-9b3c-6e39b0b2248b | consortium_followup | Wegno Pereira | 2026-09-19 13:36:06.528+00 | 0.1 |
| 634dfbdf-506b-4f5d-b7db-356c207f2184 | 198f05da-876f-455f-9095-0d7b3d758928 | return_customer | Antônio Rosa | 2026-09-19 13:28:45.852+00 | 0.1 |
| dcd0a567-e984-4ae3-bd0e-52a12f8c17d1 | fd620b78-177e-45dd-b9b9-a0cff92bedd7 | run_quote | Vasco😎 | 2026-09-19 13:51:36.586+00 | 0.1 |
| 83827620-8d75-46d2-a09c-b150afde1558 | 5068896a-958f-43cc-9970-0c5e53bd6887 | financing_followup | Elissin_xit | 2026-09-19 14:02:16.115+00 | 0.1 |
| c9dd0085-13ee-4cd5-9859-55cf040eb046 | 5068896a-958f-43cc-9970-0c5e53bd6887 | run_quote | Elissin_xit | 2026-09-19 14:02:16.115+00 | 0.1 |
| 22d49d17-8286-44cf-94c4-4d6538df4c19 | 83189383-3ea7-459c-a77a-a6bb20469007 | consortium_followup | inácio lira | 2026-09-21 14:22:19.669+00 | 0.1 |
| 53d32839-9592-4379-8104-947a469d67d2 | 1f491891-6d99-40ad-b248-8a90ed6a0e82 | return_customer | José Reis🙌 | 2026-09-21 15:25:02.766+00 | 0.1 |
| 9ea06aa3-bd2c-4244-b573-8b6af918ad0d | 83ce5fd4-bbfc-43b8-b0a6-cf7d4ab0e651 | customer_unresponsive | Francklin Vasconcelos | 2026-09-21 15:25:33.243+00 | 0.1 |
| f5b64b65-bdbc-49ba-9963-29a5c89174ce | e4745c42-0cc2-489f-853f-86b11450e0fe | customer_unresponsive | Bianca | 2026-09-21 12:43:59.424+00 | 0.1 |
| a82347d8-b42e-4034-bb2a-954538817b98 | 8a490a01-22ad-46bc-a131-179d6e98b98b | customer_unresponsive | Rodrigo | 2026-09-21 13:54:40.285+00 | 0.1 |
| 6433ded4-bce8-4d5a-a9d0-e9a21635e42f | a12635d9-973a-4352-9200-b4b365539d54 | customer_unresponsive | alexmendesps | 2026-09-21 15:30:44.964+00 | 0.1 |
| 26bbd457-000e-408b-8e0c-0d3677546afd | a12635d9-973a-4352-9200-b4b365539d54 | return_customer | alexmendesps | 2026-09-21 15:30:44.964+00 | 0.1 |
| 830af8a0-c674-4915-b96e-173360ee6ebb | d425ef9d-ae21-4cd3-b23c-97897970ae81 | consortium_followup | dalvino Severino | 2026-09-21 14:19:00.922+00 | 0.1 |
| 751b27ad-7f86-454e-b822-5b343751546b | ecf73412-6dbf-48c9-9afc-1488df8c12c3 | return_customer | Israel | 2026-09-21 15:33:47.861+00 | 0.1 |
| 6bc99d27-3398-467d-956a-1e17b577d98c | 7e2be1c6-4663-4d6a-86d8-b856de30e4fc | stalled_negotiation | Jessica Sousa | 2026-09-21 20:51:29.624+00 | 0.1 |
| 60cf29b6-1730-43b4-bbc8-08ef2a9c11ea | d6173c6c-fa2b-419f-bda5-0f09e8404593 | customer_unresponsive | . | 2026-09-21 15:53:47.442+00 | 0.1 |
| 7e53832a-57c9-4323-a214-ad4f9ecc2b74 | d6173c6c-fa2b-419f-bda5-0f09e8404593 | awaiting_customer_cpf | . | 2026-09-21 15:53:47.442+00 | 0.1 |
| b229a416-f53d-4f99-9334-fd1252230b13 | d6173c6c-fa2b-419f-bda5-0f09e8404593 | return_customer | . | 2026-09-21 15:53:47.442+00 | 0.1 |
| c7f38aeb-b4ce-44fe-b4b3-51d24a56e86d | 77696d3a-f832-4d59-a559-2b82235f811b | return_customer | Antonio Cardoso Pereira | 2026-09-21 20:01:17.997+00 | 0.1 |
| e62ef8e9-025d-492f-bb5c-695e901f829b | 83189383-3ea7-459c-a77a-a6bb20469007 | customer_unresponsive | inácio lira | 2026-09-21 14:22:19.669+00 | 0.1 |
| 4c558a16-472f-4dce-b908-c79192ee3a5f | be03de5f-7bcf-464a-9384-dc916d83def4 | consortium_followup | Edimilson | 2026-09-21 20:53:46.1+00 | 0.1 |
| 243209df-8f37-45a8-b5f9-0b3bb607bf7f | 498a6fe5-cc08-46f4-9c44-4bceccc02db6 | return_customer | Carleones Martins Filho | 2026-09-21 14:30:06.613+00 | 0.1 |
| 95484149-5d6b-48ba-bf1a-75c5f9ddeec8 | 1d7eec82-4ac7-4df5-a44e-0453a23c15e1 | return_customer | Damy | 2026-09-22 11:13:28.359+00 | 0.1 |
| a3de09dd-f091-49e9-8086-95a5a6649b50 | 6d5e145e-2e00-441b-82b9-fb6bc8328574 | run_quote | C | 2026-09-22 12:41:19.026+00 | 0.1 |
| 2b7b9ec7-3c5e-4ca0-8664-3cba87a4725b | 9f7f735e-c7e3-43f3-ad9f-226610770a31 | customer_unresponsive | Deus Mim Abençoe 🙌🙏 | 2026-09-22 12:42:55.085+00 | 0.1 |
| 5099764d-a60f-4382-b398-99b6a7aa66d9 | 2f12ac70-b938-4bf3-8b27-b1d64f24632e | customer_unresponsive | Deus É Fiel | 2026-09-22 13:29:04.253+00 | 0.1 |
| 22d8dfec-d7db-4d09-badf-c7b270e9350e | 41ea4bf4-4fa4-4cb2-9ced-ae8cd39d31d4 | financing_followup | Johnny | 2026-09-22 13:39:38.087+00 | 0.1 |
| db16a495-9998-4b51-bae2-7a44a0000fe5 | c95b3991-c40d-4c95-8d00-01fdbb3d07fa | financing_followup | sempre deus!!!! | 2026-09-22 20:27:43.638+00 | 0.1 |
| 243dbc7f-ae4b-439b-84ee-9bd567ac9d68 | 498a6fe5-cc08-46f4-9c44-4bceccc02db6 | customer_unresponsive | Carleones Martins Filho | 2026-09-21 14:30:06.613+00 | 0.1 |
| 839e60e0-afeb-4b10-a24f-3af20b8e2bcb | 0f065d31-772a-4c00-a5f4-563ddf7de986 | customer_unresponsive | Reginaldo Luiz | 2026-09-21 14:49:06.774+00 | 0.1 |
| dde64d1c-164b-479b-a85f-71fcc9030577 | a5ef1d81-4d79-4baf-b51b-a2cccbd3935b | customer_unresponsive | Maycon | 2026-09-21 14:49:38.723+00 | 0.1 |
| 2c89435f-45f2-416d-a9d0-5a4777157a9f | a5ef1d81-4d79-4baf-b51b-a2cccbd3935b | return_customer | Maycon | 2026-09-21 14:49:38.723+00 | 0.1 |
| a8b46c94-c2b1-4b52-b305-fb99acfdb526 | 138d9b3b-2e3e-426a-b0c7-b7f39e33aa2d | customer_unresponsive | rhoneicandidoferreira | 2026-09-21 14:52:34.308+00 | 0.1 |
| e68bffc7-c1ee-445f-b209-cdd0a1822445 | 138d9b3b-2e3e-426a-b0c7-b7f39e33aa2d | return_customer | rhoneicandidoferreira | 2026-09-21 14:52:34.308+00 | 0.1 |
| e3d8d236-e214-4eeb-9d4f-c6b7daffc649 | 054ffd6a-12c5-46c8-b7e5-3fb91a1c65c6 | other | hemilly | 2026-09-21 14:53:00.961+00 | 0.1 |
| 78c22774-7d31-4c52-8405-561ef78efd2c | 054ffd6a-12c5-46c8-b7e5-3fb91a1c65c6 | vehicle_followup | hemilly | 2026-09-21 14:53:00.961+00 | 0.1 |
| 16a1ae18-dab7-4541-9481-3edb7f66c13a | 4ae896f7-c868-44d5-b601-17745be0b66c | customer_unresponsive | Rejane Rufino | 2026-09-21 15:24:25.089+00 | 0.1 |
| 9f4ce585-bd7b-45d7-8d71-b2f6405f5d2b | db3cd270-20e7-411d-a5d0-7287f4c90de5 | return_customer | Nubia | 2026-09-21 20:34:12.002+00 | 0.1 |
| 127a86a6-57ef-48b1-8c61-ed37e2a32b80 | 41ea4bf4-4fa4-4cb2-9ced-ae8cd39d31d4 | return_customer | Johnny | 2026-09-22 13:39:38.087+00 | 0.1 |
| a289c860-5477-4298-a894-11c3e85d7d96 | f1bd28b9-0cb0-4d3b-9f7b-afc7bfdcdd48 | consortium_followup | Ginaldo Pereira Alves | 2026-09-21 15:18:48.494+00 | 0.1 |
| b8a33ac5-6462-4daa-bae8-a7a504b0013b | f1bd28b9-0cb0-4d3b-9f7b-afc7bfdcdd48 | run_quote | Ginaldo Pereira Alves | 2026-09-21 15:18:48.494+00 | 0.1 |
| 65bd756f-471a-4233-b4c5-a189232beb7a | 4ae896f7-c868-44d5-b601-17745be0b66c | proposal_followup | Rejane Rufino | 2026-09-21 15:24:25.089+00 | 0.1 |
| 6e37b9c8-54e4-4c57-a1b6-e3d8169dea63 | fd15e2bd-ab4a-4686-a1cc-fca34de493ae | other | James | 2026-09-21 20:59:10.082+00 | 0.1 |
| 1ff34d38-80d3-4093-a1f9-cadeaabeed40 | 98fe7caa-ad61-4d7b-a627-7b0294766e20 | customer_unresponsive | Ronaldo | 2026-09-21 12:48:56.629+00 | 0.1 |
| 311e7281-4167-42e0-b211-2da330fe9f71 | db3cd270-20e7-411d-a5d0-7287f4c90de5 | consortium_followup | Nubia | 2026-09-21 20:34:12.001+00 | 0.1 |
| 7524cf9a-17d4-46d4-a887-960de79a6b40 | 98fe7caa-ad61-4d7b-a627-7b0294766e20 | return_customer | Ronaldo | 2026-09-21 12:48:56.629+00 | 0.1 |
| 0884b364-2ec3-464a-9b3b-5b1ffe8c9372 | 5d202809-b73a-4024-b91e-d8c20b03d450 | financing_followup | Jaqueline Santana | 2026-09-21 12:53:18.87+00 | 0.1 |
| 3d5dd286-ec4c-4a23-b645-0a9e1a802d66 | 5d202809-b73a-4024-b91e-d8c20b03d450 | run_quote | Jaqueline Santana | 2026-09-21 12:53:18.871+00 | 0.1 |
| e8d2963d-3de1-4913-ba60-f68355a072de | c65f2d14-c91b-4e8a-8feb-d41d21cb571b | return_customer | Jorge Saraiva | 2026-09-22 12:43:16.275+00 | 0.1 |
| ff6ea7d1-b45a-4cc8-bfde-0bd8755fac3a | 0b52578c-c938-486a-81d7-34bfe53597e4 | return_customer | Zilda Rocha | 2026-09-21 15:23:32.147+00 | 0.1 |
| 20dd6184-fcf1-48bc-9cb0-8a75397e79c1 | 0b52578c-c938-486a-81d7-34bfe53597e4 | customer_unresponsive | Zilda Rocha | 2026-09-21 15:23:32.147+00 | 0.1 |
| 6495c07f-17f6-4a02-9031-d0a2110bae9e | 1f491891-6d99-40ad-b248-8a90ed6a0e82 | customer_unresponsive | José Reis🙌 | 2026-09-21 15:25:02.766+00 | 0.1 |
| 834051de-1d40-4786-af53-9968e840216c | a68b5e7e-0e03-42ef-8aee-7523fed22c0d | customer_unresponsive | alisson | 2026-09-21 15:25:50.486+00 | 0.1 |
| 4755598d-4873-46bd-860b-35ddf1da38d4 | a68b5e7e-0e03-42ef-8aee-7523fed22c0d | return_customer | alisson | 2026-09-21 15:25:50.486+00 | 0.1 |
| b396f2bd-de5d-471a-862f-8aeaff271307 | fd15e2bd-ab4a-4686-a1cc-fca34de493ae | consortium_followup | James | 2026-09-21 20:59:10.082+00 | 0.1 |
| a9e45853-a31c-4fc8-b728-1ad8e72c453a | 3d1f8955-1714-4b53-9b73-11fd3f3e4893 | consortium_followup | Edimar | 2026-09-21 20:49:44.954+00 | 0.1 |
| c8f91ac1-9c93-46ee-8915-c7b6498375ac | c853de6b-0648-4eab-8b7a-c810ec5f73da | customer_unresponsive | Adryan, Neythan, Adrylle. | 2026-09-21 12:20:22.917+00 | 0.1 |
| ac107273-4556-42a0-ab9c-18913630cc7a | 4dd80f5b-2652-47b1-b612-a4f238e5b8ea | customer_unresponsive | Antonio Jose alves | 2026-09-21 12:43:42.527+00 | 0.1 |
| 493b48cd-f3c9-4c3e-879b-f0b8826476b1 | 4dd80f5b-2652-47b1-b612-a4f238e5b8ea | return_customer | Antonio Jose alves | 2026-09-21 12:43:42.528+00 | 0.1 |
| eb0a05a7-3564-4f70-a801-5a52cc0e2725 | c65f2d14-c91b-4e8a-8feb-d41d21cb571b | customer_unresponsive | Jorge Saraiva | 2026-09-22 12:43:16.275+00 | 0.1 |
| e6e8410e-63d5-4ea2-bdd6-f3cb9a045e9e | 560956de-0ae3-4c1e-ac77-0e07270bccb0 | scheduled_callback | . | 2026-09-21 15:35:27.119+00 | 0.1 |
| fe9596a5-532c-4dce-b413-d535f1faf181 | bbdc039b-2b44-45c8-afa5-f7709c3b0a20 | return_customer | Fabio Eustaquio | 2026-09-21 15:28:26.501+00 | 0.1 |
| a163c624-3a1d-4bf6-8cd5-12be41daeae8 | ecf73412-6dbf-48c9-9afc-1488df8c12c3 | consortium_followup | Israel | 2026-09-21 15:33:47.861+00 | 0.1 |
| 21271761-ae9e-49e7-99f8-66cb70a3ebaf | 6d503f84-702e-4b65-9b71-63fef3cd325c | return_customer | Ruy | 2026-09-21 11:50:42.111+00 | 0.1 |
| f970c9e4-3182-49fe-bea2-39714f966945 | 6d503f84-702e-4b65-9b71-63fef3cd325c | customer_unresponsive | Ruy | 2026-09-21 11:50:42.111+00 | 0.1 |
| f7900345-9c1c-4a9a-b0c0-1fca0e7fc4f6 | c853de6b-0648-4eab-8b7a-c810ec5f73da | return_customer | Adryan, Neythan, Adrylle. | 2026-09-21 12:20:22.918+00 | 0.1 |
| 8529c2a4-7ab4-42c2-83db-66dbc0d20c39 | 78636969-fa70-416b-b7fb-f4d7e98256a3 | customer_unresponsive | Julmar | 2026-09-21 12:46:27.265+00 | 0.1 |
| 0e8aa3c6-57e6-4813-b800-5bb19ac86faa | 5a40a525-2367-439e-998a-17558590a595 | run_quote | ♥️ | 2026-09-21 12:48:01.008+00 | 0.1 |
| f5ebba77-c01d-4338-9ad1-5754b3e05879 | 98fe7caa-ad61-4d7b-a627-7b0294766e20 | run_quote | Ronaldo | 2026-09-21 12:48:56.628+00 | 0.1 |
| a7d43ec1-51d2-4d3e-9ab1-bed0ae7e6fa1 | 98fe7caa-ad61-4d7b-a627-7b0294766e20 | financing_followup | Ronaldo | 2026-09-21 12:48:56.629+00 | 0.1 |
| 3084949b-d725-47a2-8a43-0838dbbfd6b4 | 53476ae4-34bd-47fc-8465-71d3d14e0377 | customer_unresponsive | Bruno Bernardo aleixo | 2026-09-21 20:07:17.147+00 | 0.1 |
| 6ce3a24b-7d34-4778-b152-ffc98ffd0828 | 53476ae4-34bd-47fc-8465-71d3d14e0377 | return_customer | Bruno Bernardo aleixo | 2026-09-21 20:07:17.147+00 | 0.1 |
| 18cea9b1-2dca-4b7c-8643-637cee22558c | 8a490a01-22ad-46bc-a131-179d6e98b98b | consortium_followup | Rodrigo | 2026-09-21 13:54:40.285+00 | 0.1 |
| 3172f1b6-28de-4e2a-92de-fa495122b8a1 | 8a490a01-22ad-46bc-a131-179d6e98b98b | scheduled_callback | Rodrigo | 2026-09-21 13:54:40.285+00 | 0.1 |
| 30c4e3e6-2e71-498e-8b3c-7635b66c682f | 77696d3a-f832-4d59-a559-2b82235f811b | consortium_followup | Antonio Cardoso Pereira | 2026-09-21 20:01:17.996+00 | 0.1 |
| 7b18b89e-4664-483f-9cb8-14ff145d8b1e | 78c28ae7-c0c5-44fd-b359-9dce169cf873 | consortium_followup | Vini | 2026-09-22 13:34:19.789+00 | 0.1 |
| 0d760162-1f34-4377-be49-5914d8f33fba | 960a385c-7bac-475f-bcf0-d713b45c3c10 | financing_followup | Igor Chagas | 2026-09-22 14:49:48.962+00 | 0.1 |
| 85bc7618-73a5-4383-93af-b5ee0451e0ee | 646b5f34-41f1-4c07-9ca6-8f0e36c15b1a | consortium_followup | conta comercial | 2026-09-22 15:46:19.608+00 | 0.1 |
| 01abb872-a4e7-4268-a796-5fad83e1dc19 | 34aca46b-1dc3-4208-876a-c02af2f777a9 | stalled_negotiation | Gledson dantas | 2026-09-22 19:14:02.66+00 | 0.1 |
| 017c5026-668e-43a0-8cfc-2a7b4db1c80b | 34aca46b-1dc3-4208-876a-c02af2f777a9 | proposal_followup | Gledson dantas | 2026-09-22 19:14:02.66+00 | 0.1 |
| 9a69b370-6e3d-4f92-adbf-a4f821a20054 | 153dd68a-0c96-4a71-9ee2-e68cae2e286a | stalled_negotiation | Maria Bezerra | 2026-09-22 19:36:50.739+00 | 0.1 |
| dc7434c2-4fd8-4160-ae5b-3a2d2d0f3db4 | 153dd68a-0c96-4a71-9ee2-e68cae2e286a | return_customer | Maria Bezerra | 2026-09-22 19:36:50.739+00 | 0.1 |
| 60ee098c-d162-4ce7-8bba-e6157b185dd9 | ebaddc92-6b24-4137-8287-824f26deb9fe | return_customer | ... | 2026-09-22 19:38:25.025+00 | 0.1 |
| 8fc9ac53-08bb-4e1d-990a-77b572703466 | c28b187f-8b74-4d86-b134-aef42549b3e1 | customer_unresponsive | Milson | 2026-09-22 20:13:55.695+00 | 0.1 |
| 7a367846-c59f-421e-baa2-4bbe96130a39 | 4abad23b-93a1-47df-b0d0-0516f637a8ee | run_quote | Deus | 2026-09-22 20:14:21.073+00 | 0.1 |
| ffed3d9d-4e3e-408d-8f7a-7594ae02dde5 | 7071f7b6-6432-4fc9-bc4a-b867f86d24f8 | customer_unresponsive | Laudemir Fernandes | 2026-09-22 20:15:29.484+00 | 0.1 |
| 2e1642ce-4b35-46b2-927a-44248508f5eb | f77c133d-b0ae-4a23-9b86-529bda8247fd | customer_unresponsive | Angelo | 2026-09-22 20:19:45.625+00 | 0.1 |
| e3f36cae-d6a2-4368-b322-15892e515bbb | 8a607af6-719a-47bc-9942-9401fea7e5bd | customer_unresponsive | Rogerio | 2026-09-22 20:19:21.138+00 | 0.1 |
| 1a638fe3-77f6-4047-9845-61bc837f1731 | c95b3991-c40d-4c95-8d00-01fdbb3d07fa | customer_unresponsive | sempre deus!!!! | 2026-09-22 20:27:43.638+00 | 0.1 |
| 616536f8-0fe6-44d7-ad45-04bce35f7230 | 123f4a8c-67c8-444f-b24e-4b559b1825c9 | customer_unresponsive | ...... | 2026-09-22 20:28:24.567+00 | 0.1 |
| 0629d56c-41a4-4665-87fb-476a171619bc | 7e2be1c6-4663-4d6a-86d8-b856de30e4fc | customer_unresponsive | Jessica Sousa | 2026-09-21 20:51:29.624+00 | 0.1 |
| b5bef5d4-8cf9-4e10-b89a-2f24b603fdb5 | 646b5f34-41f1-4c07-9ca6-8f0e36c15b1a | return_customer | conta comercial | 2026-09-22 15:46:19.608+00 | 0.1 |
| 9616b873-d84f-4e5c-a32c-02b92b94f733 | 8f5ccd8c-ccd7-4e5c-9dae-63c86c002895 | consortium_followup | kaique | 2026-09-12 12:33:48.217+00 | 0.1 |
| 0b4c0c22-3da6-4b54-83bf-f1a1cb2ad93e | b58d340c-6079-4449-b608-1f367c19ffb0 | customer_unresponsive | Anna💜 | 2026-09-21 21:04:28.115+00 | 0.1 |
| 8453f439-cfde-4df6-a5f3-83a31fc1ac6b | b58d340c-6079-4449-b608-1f367c19ffb0 | return_customer | Anna💜 | 2026-09-21 21:04:28.115+00 | 0.1 |
| c431b87a-637a-45d5-bf7c-608d6bfab5ba | 60a88c9c-a0ae-4ed5-817a-954be7241533 | proposal_followup | Carlos lira | 2026-09-12 14:30:57.368+00 | 0.1 |
| 0303ec54-8385-4930-ba04-6dfc90e9e7bb | 4151a0cd-3019-46e9-aad8-4f2d4f906be9 | consortium_followup | Alex Almeida | 2026-09-17 15:00:34.126+00 | 0.1 |
| e7112fee-e4ae-4a71-a297-13839dfb1ba3 | 4f8cc3ca-f5cd-44f5-ade5-40a0340943d3 | customer_unresponsive | Chauã Costa | 2026-09-17 15:04:02.745+00 | 0.1 |
| e93a344e-80d4-4de5-8220-7c402f68941e | 646b5f34-41f1-4c07-9ca6-8f0e36c15b1a | customer_unresponsive | conta comercial | 2026-09-22 15:46:19.608+00 | 0.1 |
| ec1b5dda-2d8a-422a-b9de-e40f6be8c9f1 | 4f8cc3ca-f5cd-44f5-ade5-40a0340943d3 | return_customer | Chauã Costa | 2026-09-17 15:04:02.745+00 | 0.1 |
| 1cd506ad-1a42-4c5b-8393-5538c85b1495 | 4c858cd5-6986-43d5-9489-1cce7d70a6ef | financing_followup | Mikelvon Ribeiro De Freit | 2026-09-17 21:02:47.032+00 | 0.1 |
| 4ca433a4-b708-4dec-ad9b-41a8c36aa295 | a5c7bda7-24a4-4827-aa69-e932c5f22f3b | consortium_followup | DomingosPereira Lopes | 2026-09-17 15:08:30.108+00 | 0.1 |
| 7332f6b0-ef26-4103-9427-f42fb669da8e | b61465ee-539e-4678-aedb-97a36580612d | customer_unresponsive | . | 2026-09-14 15:23:18.718+00 | 0.1 |
| 03df53f7-86db-4721-a3ba-f8354f9ecc68 | 60a88c9c-a0ae-4ed5-817a-954be7241533 | customer_unresponsive | Carlos lira | 2026-09-12 14:30:57.368+00 | 0.1 |
| b9763168-0e37-4e0c-94a0-1d48a3637003 | ab5603fb-b920-444f-a8b2-56441e479a40 | consortium_followup | João Luiz Nunes dos Santo | 2026-09-09 18:35:31.529+00 | 0.1 |
| 111ab75b-1c4e-43d1-961e-1e3bc5d85f0a | 4c858cd5-6986-43d5-9489-1cce7d70a6ef | run_quote | Mikelvon Ribeiro De Freit | 2026-09-17 21:02:47.032+00 | 0.1 |
| a5304dfb-3762-4e3e-8da5-58bc02ebe4fa | 15d5516f-6641-4076-9a22-251e40b95816 | return_customer | Betim | 2026-09-18 19:17:40.425+00 | 0.1 |
| 1b78d446-5759-4a0f-b9fa-de3a07657cd6 | 55840cf8-35e2-4109-b97f-f223aefbb13a | customer_unresponsive | Pedro Rodrigues Pereira | 2026-09-10 11:08:09.626+00 | 0.1 |
| c52cb47f-98ef-433a-9d5b-6af51f64f767 | 77b66587-8b05-4f6f-a9e2-76d2e93cbd99 | scheduled_callback | Assis | 2026-09-12 13:24:16.347+00 | 0.1 |
| dc9c51db-79fc-4442-aa13-3e5f440aab45 | 39208d3c-ba54-43fa-acd9-60036f5f1a40 | return_customer | Edvaldo de Araújo Alves | 2026-09-12 12:38:14.957+00 | 0.1 |
| 8f4e3759-3148-434b-875d-f7215ae56b9b | 77b66587-8b05-4f6f-a9e2-76d2e93cbd99 | consortium_followup | Assis | 2026-09-12 13:24:16.347+00 | 0.1 |
| 4e05c325-18fa-49c2-bdc1-0304f59701a0 | 39208d3c-ba54-43fa-acd9-60036f5f1a40 | customer_unresponsive | Edvaldo de Araújo Alves | 2026-09-12 12:38:14.957+00 | 0.1 |
| cc4a8f22-70a8-4ae2-8247-98b6a2c26c85 | bec44b7f-253d-4632-9635-21bc424acf3b | return_customer | Raissa Moreira | 2026-09-12 13:29:13.976+00 | 0.1 |
| d56aa4fa-59c7-4bcd-a2b3-8c0528084521 | e147e0f1-cd84-41d5-b0cd-3bf801061180 | customer_unresponsive | RezaBraba😎🏄🏾‍♂️🤞🏾 | 2026-09-18 13:03:23.012+00 | 0.1 |
| 1d253ce8-f7e2-477d-8d55-92b2f1a46bbb | 4abad23b-93a1-47df-b0d0-0516f637a8ee | stalled_negotiation | Deus | 2026-09-22 20:14:21.073+00 | 0.1 |
| 7a36c6f9-c42f-4cdb-8997-08fea5340b44 | 9f2f5941-dc91-445b-9755-9a6e8dd31fd3 | customer_unresponsive | Valdinez | 2026-09-11 11:41:39.259+00 | 0.1 |
| 12accead-1483-48b0-8c0a-8e6f77c291e0 | bec44b7f-253d-4632-9635-21bc424acf3b | customer_unresponsive | Raissa Moreira | 2026-09-12 13:29:13.976+00 | 0.1 |
| 0a6b4d9b-c7bf-4335-9290-b8def1729378 | 86629bb7-a878-4143-b1ee-9b11774a3fb3 | customer_unresponsive | WILL🦂🦂⭐⭐⭐⭐⭐ | 2026-09-15 11:36:39.222+00 | 0.1 |
| abae5f75-e97d-4982-a292-a68a7fcc1cd7 | aed7bcab-b059-46f4-96d3-79dfe868fe33 | consortium_followup | Paulo Ricardo 😁👊 | 2026-09-18 13:59:36.433+00 | 0.1 |
| 9ff72ba8-0ce2-4f40-a0aa-c20efe0644c1 | 33e712b8-1855-427a-90d5-e3e7e531cd37 | customer_unresponsive | Andrelival | 2026-09-16 13:19:06.733+00 | 0.1 |
| 900aafa5-b9e1-4017-b006-b8a731d4db1f | 1ca86a7e-6afb-4f34-87f5-f5b09bb351cc | customer_unresponsive | Eu E Ele.meu Amor ❤️❤️🙏 | 2026-09-18 14:01:36.301+00 | 0.1 |
| 1acb875f-379d-457b-9686-1a1a44358ab1 | 86711061-a790-4be7-aecd-80b64ef6ebf3 | customer_unresponsive | djalmaalves70 | 2026-09-19 13:35:43.626+00 | 0.1 |
| 601a236f-e5dc-441b-ab28-39634048e3fa | 1b7f364c-1578-4b1a-ae83-a162ad6f91e9 | return_customer | Luciene | 2026-09-15 19:05:49.261+00 | 0.1 |
| 77e75669-a2f0-48cb-a18f-0fdc735bbed2 | 73457100-5a2b-461a-91cf-14f435f10896 | customer_unresponsive | Isaías araujo | 2026-09-22 20:19:07.957+00 | 0.1 |
| 2ba5b08d-33ad-44da-91a9-adb040355955 | b948d201-8dcd-40fd-a209-72274a404685 | proposal_followup | Adriano | 2026-09-14 14:00:41.747+00 | 0.1 |
| 68c21930-ad7a-4203-8788-00bed999f165 | eb555e56-c9ad-44d9-9c94-972d1cc1ab2c | return_customer | Pablo Emílio Escobar | 2026-09-14 14:05:08.099+00 | 0.1 |
| 5ecba19d-de78-4778-af3f-72494391f5a1 | b885915b-60c9-490d-b730-7af0a204a592 | proposal_followup | Robesio😎 | 2026-09-14 14:31:10.86+00 | 0.1 |
| 4a6f26db-b993-48c4-8744-5d7b685237f9 | 1b8147c3-684e-4082-9c70-e88bf0e6f01e | vehicle_followup | 🙏🙏🙏🙏🙏 | 2026-09-14 15:40:04.165+00 | 0.1 |
| 56c2c3a7-aa74-4ce0-919c-38895ab20627 | 1b114482-8791-4401-b780-96cc4a0b0e38 | consortium_followup | Matheus | 2026-09-12 12:09:17.695+00 | 0.1 |
| f99ad802-806c-4afe-ae6a-469bfb154e57 | 132027ac-2d05-4920-b70b-5efd3ef20114 | run_quote | Carlos Fonseca | 2026-09-14 13:18:38.813+00 | 0.1 |
| 8d63136c-4c12-444e-969e-f685def0d96c | bac356dc-f9ab-48e8-bc44-c1db1db9111c | proposal_followup | R | 2026-09-14 14:02:13.03+00 | 0.1 |
| ec0c11cc-357a-4231-a30d-e1ad02e47bad | 1b8147c3-684e-4082-9c70-e88bf0e6f01e | customer_unresponsive | 🙏🙏🙏🙏🙏 | 2026-09-14 15:40:04.165+00 | 0.1 |
| cd96f690-37ce-4193-9674-15202ae32cfd | bac356dc-f9ab-48e8-bc44-c1db1db9111c | customer_unresponsive | R | 2026-09-14 14:02:13.03+00 | 0.1 |
| 22410165-2400-41f1-9d4e-881c1df7b912 | cc995c33-fd16-4926-8e3a-3752528a336d | customer_unresponsive | Clemilton | 2026-09-14 15:14:57.08+00 | 0.1 |
| 720a0f4e-ea62-4802-85d0-8cff4c48fe92 | cc995c33-fd16-4926-8e3a-3752528a336d | return_customer | Clemilton | 2026-09-14 15:14:57.08+00 | 0.1 |
| b20de7af-c9f8-4da2-9cba-d8e2b95142ca | de7885b8-560f-4d6a-ad64-7bc9b29bddd0 | consortium_followup | Pedro | 2026-09-22 19:31:55.056+00 | 0.1 |
| fae0f8fb-dab2-4764-8aa1-62a5d14b87af | 86629bb7-a878-4143-b1ee-9b11774a3fb3 | return_customer | WILL🦂🦂⭐⭐⭐⭐⭐ | 2026-09-15 11:36:39.221+00 | 0.1 |
| 848f42a0-793a-4cee-a486-2fcc79b631a6 | 4309696d-f6cc-4e80-9adf-6fd3bb3de019 | customer_unresponsive | Caio | 2026-09-18 19:49:38.782+00 | 0.1 |
| 786941e4-c1df-4276-a83a-dc87e00e3ce9 | 3e9730a2-a248-4172-bc8a-a16d828190a1 | return_customer | Rheider Borges Guimaraes | 2026-09-12 12:32:11.947+00 | 0.1 |
| 68fc37e8-0389-47c4-b4ed-c1c76abf15dc | 0ed23ecb-46ea-462e-8370-c948bb15b955 | return_customer | Vando | 2026-09-19 13:45:24.165+00 | 0.1 |
| f5ead2d1-e56b-458c-b0e1-ed242714f336 | c093a249-f55f-4a64-802b-9fb68beea2d2 | customer_unresponsive | Saulo Martins | 2026-09-19 13:45:45.699+00 | 0.1 |
| 6000b844-a207-4954-8518-6d62ba069a5c | d7ec09b0-3098-4308-995b-25581761191e | vehicle_followup | jamyllyd31 | 2026-09-17 21:28:39.83+00 | 0.1 |
| 4d56bdeb-3909-43ed-afb7-28b76c4e8dda | 694668b5-fcb4-4bd0-beb3-2c4926aff9a3 | return_customer | . | 2026-09-18 14:10:02.633+00 | 0.1 |
| 4a9fe5a0-15e4-42e9-a06f-d0291e38a5c5 | 6efcea15-64b9-4f81-9f7f-ec2255b4a53f | customer_unresponsive | Duarte79 | 2026-09-18 19:49:19.542+00 | 0.1 |
| 0ad0be77-351c-4ca6-b221-1d44d3300d6c | 3e9730a2-a248-4172-bc8a-a16d828190a1 | customer_unresponsive | Rheider Borges Guimaraes | 2026-09-12 12:32:11.947+00 | 0.1 |
| 8bfae787-af36-4c11-aad2-4a1b5c25a282 | c093a249-f55f-4a64-802b-9fb68beea2d2 | return_customer | Saulo Martins | 2026-09-19 13:45:45.699+00 | 0.1 |
| 4025a014-47a8-463c-80f3-27e00c6a3367 | f37d72f7-82a4-4fd0-8235-ccadf049ca1e | awaiting_customer_cpf | Daniel | 2026-09-14 13:20:24.983+00 | 0.1 |
| 8c4ea4cd-73e9-4c6d-8744-4f38f602fc6e | 0196d1f6-4670-4b32-8dc8-eab094706a30 | return_customer | Pr. Miguel Anjo 🇻🇪🇧🇷 | 2026-09-14 15:13:24.431+00 | 0.1 |
| 6354536e-9065-4141-8493-c0ac3d4d370c | 4254d072-077a-4aec-b9de-5e68d2a7d481 | customer_unresponsive | Paulo Inacia | 2026-09-14 15:35:04.844+00 | 0.1 |
| e9a5aa25-8b30-4f3a-a973-87489c24180d | f37d72f7-82a4-4fd0-8235-ccadf049ca1e | awaiting_customer_data | Daniel | 2026-09-14 13:20:24.983+00 | 0.1 |
| c2ff1f62-40f0-46d1-a4ab-214744850af6 | 960a385c-7bac-475f-bcf0-d713b45c3c10 | run_quote | Igor Chagas | 2026-09-22 14:49:48.962+00 | 0.1 |
| 2e47a640-70b7-48c7-ad85-53cc75091f2f | d29107d3-5c76-487c-a21d-24f59db29c4b | customer_unresponsive | . Moisés dourado Rodrigue | 2026-09-15 12:20:10.523+00 | 0.1 |
| c530746f-163f-4fc5-bb21-3eec8e3fc425 | 09749e05-c9b5-4eff-910e-5ff64687ee41 | consortium_followup | Samuel Silva | 2026-09-15 12:57:38.804+00 | 0.1 |
| 071d53ab-df36-4fc3-8e67-379d5b71dddb | 04bc522f-2fe1-4e16-9b6a-0350911cf85e | customer_unresponsive | Raquel | 2026-09-18 13:29:54.205+00 | 0.1 |
| 90e01386-3f1f-40c3-839a-4b8c61d2171d | 05b1c38b-3492-4a4c-9828-75fa3eed9a90 | customer_unresponsive | Edmilson | 2026-09-18 14:25:08.603+00 | 0.1 |
| 8eb71092-75cc-4724-a5b2-5593fc59e2eb | c091d077-1815-4d33-9c09-d8012342f5a5 | customer_unresponsive | oliveira_antonioantonio | 2026-09-18 20:23:03.478+00 | 0.1 |
| 3baf2229-6dab-49d9-b19e-b719c90c229e | fc862b39-28f6-4346-8a85-ad4fa240f568 | customer_unresponsive | Zullu | 2026-09-18 20:45:51.705+00 | 0.1 |
| eb0beedc-8a67-471a-992a-f6a0f8373085 | c124c2e8-6b24-4a3a-b70a-3738fc9abe7c | customer_unresponsive | Elaine Borges de oliveira | 2026-09-14 13:21:19.093+00 | 0.1 |
| c700a779-963b-4377-b06c-5841cb5547a3 | 807de57f-de08-4db4-bff4-de78d88fcfc6 | customer_unresponsive | Antônio Alves | 2026-09-14 14:42:12.887+00 | 0.1 |
| 16a4e010-8c08-42d7-9623-299197e1a7b8 | b61465ee-539e-4678-aedb-97a36580612d | consortium_followup | . | 2026-09-14 15:23:18.718+00 | 0.1 |
| e2a3eb4e-dc3a-4baf-a52b-f6cdf0abb016 | 05b1c38b-3492-4a4c-9828-75fa3eed9a90 | return_customer | Edmilson | 2026-09-18 14:25:08.603+00 | 0.1 |
| 4b428a55-c610-45df-b481-0348da9a88d3 | d29107d3-5c76-487c-a21d-24f59db29c4b | return_customer | . Moisés dourado Rodrigue | 2026-09-15 12:20:10.523+00 | 0.1 |
| 2c599656-cff7-43d5-8e21-9862e50c2705 | 5d79041d-5549-460f-ba9d-396465d68cf9 | vehicle_followup | joseteodorosantos0 | 2026-09-14 13:37:46.697+00 | 0.1 |
| 2e33b4e5-5d6b-46de-940d-f7610111143e | 5d79041d-5549-460f-ba9d-396465d68cf9 | customer_unresponsive | joseteodorosantos0 | 2026-09-14 13:37:46.697+00 | 0.1 |
| 15f7424d-0931-4ec0-b732-01827256eed0 | 238db8b3-a240-477d-9cc5-af9a912948f6 | consortium_followup | Wagner dos Santos Oliveir | 2026-09-14 13:51:11.947+00 | 0.1 |
| 5252fcdc-2d5f-4c45-8f74-e605f6ea2f75 | 221a51a4-e642-45ab-89b3-47fafa7b566b | return_customer | geovaniosilva1707 | 2026-09-14 13:55:38.226+00 | 0.1 |
| 805c50f7-abf6-4fd4-824f-4ef163759aed | b948d201-8dcd-40fd-a209-72274a404685 | customer_unresponsive | Adriano | 2026-09-14 14:00:41.748+00 | 0.1 |
| 18115cf3-26cd-4d6a-8149-3e379db78a0f | 34167613-aff9-4b8e-bd4d-8df90b2e1b4a | customer_unresponsive | Eduardo Soares | 2026-09-14 14:30:58.36+00 | 0.1 |
| 9f81de44-4fd7-4d46-83c2-48d896c06454 | 0196d1f6-4670-4b32-8dc8-eab094706a30 | customer_unresponsive | Pr. Miguel Anjo 🇻🇪🇧🇷 | 2026-09-14 15:13:24.431+00 | 0.1 |
| 8acbb9c3-1c10-4652-8d67-f30545ce65a5 | 221a51a4-e642-45ab-89b3-47fafa7b566b | customer_unresponsive | geovaniosilva1707 | 2026-09-14 13:55:38.226+00 | 0.1 |
| 48aa09a7-fe0f-4fa3-8a7e-16496c7dc807 | 221a51a4-e642-45ab-89b3-47fafa7b566b | consortium_followup | geovaniosilva1707 | 2026-09-14 13:55:38.226+00 | 0.1 |
| 3c9df449-24ed-4428-bc17-abe3e61d2dbd | 5999567a-2daf-4fea-bae2-8af77445ce22 | customer_unresponsive | Ronilson | 2026-09-14 14:04:52.81+00 | 0.1 |
| 8d123c82-4005-4b71-9acb-f3b48da15454 | eb555e56-c9ad-44d9-9c94-972d1cc1ab2c | customer_unresponsive | Pablo Emílio Escobar | 2026-09-14 14:05:08.099+00 | 0.1 |
| d1894534-c9a0-4503-bac1-5bb6f07de6e1 | eece4e65-93de-474c-a593-b95b8bc9b4ac | customer_unresponsive | Pedro Barbosa | 2026-09-14 14:09:00.864+00 | 0.1 |
| 5f30cf20-b680-44f9-a074-dab018b35caa | eece4e65-93de-474c-a593-b95b8bc9b4ac | return_customer | Pedro Barbosa | 2026-09-14 14:09:00.864+00 | 0.1 |
| ae546acf-6b9d-4b38-aee2-ef05a492b7c6 | 3f0555dc-904f-4c36-8adb-463a04a431dd | financing_followup | Nilson Bueno | 2026-09-14 14:22:42.524+00 | 0.1 |
| 8dd40fa0-19cb-4b0b-859e-6bb53ab82919 | 3f0555dc-904f-4c36-8adb-463a04a431dd | customer_unresponsive | Nilson Bueno | 2026-09-14 14:22:42.524+00 | 0.1 |
| e703b0a4-9d9b-4b00-8c34-5ef2c1b160db | b885915b-60c9-490d-b730-7af0a204a592 | customer_unresponsive | Robesio😎 | 2026-09-14 14:31:10.86+00 | 0.1 |
| c3039de1-4395-4998-aa82-a1c1f0dd8db1 | d6cb5bfb-3e37-4861-9e1e-470dcc1aa1a3 | customer_unresponsive | Adriano Lopes | 2026-09-14 14:42:24.831+00 | 0.1 |
| e0badfcc-9de3-4fcc-971f-b1f6f3c62e51 | d6cb5bfb-3e37-4861-9e1e-470dcc1aa1a3 | return_customer | Adriano Lopes | 2026-09-14 14:42:24.831+00 | 0.1 |
| 2f5e8118-550f-4192-bbe3-9133cbcbef0c | ced5c103-d748-4261-a745-8f7e9ebc1761 | consortium_followup | Joseval | 2026-09-14 15:07:35.625+00 | 0.1 |
| 2261f439-4fa0-454c-affa-d919d6a61f57 | 4c7ae370-1cc8-4560-9275-2a2cca4d839c | customer_unresponsive | 🙏🏻 Deus😍😍 | 2026-09-22 18:20:49.719+00 | 0.1 |
| c249066f-ddce-4a13-beec-d2dff60482f1 | 4ae1b3f2-069c-4d7b-97bf-db7eac8c068f | consortium_followup | Alves | 2026-09-16 13:50:31.415+00 | 0.1 |
| 1bbdf04d-8a19-4d02-9303-f9ec3e586b98 | 0334686e-6045-4db4-99e6-3ca6328def24 | vehicle_followup | 💋Cidinha 💋💚💚 | 2026-09-18 20:37:57.222+00 | 0.1 |
| 2896a5cb-af47-4d84-97da-519a85602fde | 3029f124-174b-44d5-aeaf-debda0ddb0ff | customer_unresponsive | Gedson Farias | 2026-09-14 15:17:50.629+00 | 0.1 |
| 8da0a372-f0d5-440e-8d9d-2a88fb895d8d | 7c991289-1896-4220-954a-a543f27ea222 | customer_unresponsive | Eder Reis | 2026-09-14 15:25:00.548+00 | 0.1 |
| 3faed1b5-2f6a-4afb-a13b-2f815355655a | 7c991289-1896-4220-954a-a543f27ea222 | return_customer | Eder Reis | 2026-09-14 15:25:00.548+00 | 0.1 |
| 4f7d064c-5c29-49ba-87cc-6aecedf02791 | 4254d072-077a-4aec-b9de-5e68d2a7d481 | vehicle_followup | Paulo Inacia | 2026-09-14 15:35:04.844+00 | 0.1 |
| cdf7676d-0c75-499e-924a-a571ee75b5f0 | a923397f-565d-4b4d-9e16-985315562bba | return_customer | Você Sabe????? | 2026-09-14 15:19:02.37+00 | 0.1 |
| 08495923-2e4f-4d63-a7ea-777f72de582d | a923397f-565d-4b4d-9e16-985315562bba | customer_unresponsive | Você Sabe????? | 2026-09-14 15:19:02.37+00 | 0.1 |
| 4b3473bd-2270-4996-8a50-bd2448e99103 | 99c5320f-1144-4a8a-8d5e-c3ead4abe148 | vehicle_followup | Kamilla | 2026-09-14 15:22:36.632+00 | 0.1 |
| 3fc79f35-f595-48fc-99c5-d6c88b092b47 | 2d9a7136-9ea7-4ca4-8678-c0693ea41285 | run_quote | Gabi Nery | 2026-09-14 15:34:41.595+00 | 0.1 |
| 028016bc-4975-4607-8991-854df388bb34 | 132027ac-2d05-4920-b70b-5efd3ef20114 | consortium_followup | Carlos Fonseca | 2026-09-14 13:18:38.813+00 | 0.1 |
| 181ef28f-f1f2-4072-8b9b-1e36b518f1d3 | 2d9a7136-9ea7-4ca4-8678-c0693ea41285 | customer_unresponsive | Gabi Nery | 2026-09-14 15:34:41.595+00 | 0.1 |
| 9bb0b3d9-603d-4a6f-a14d-75b2eede40f1 | 2d9a7136-9ea7-4ca4-8678-c0693ea41285 | financing_followup | Gabi Nery | 2026-09-14 15:34:41.595+00 | 0.1 |
| 2e5167dc-1424-496a-89cc-1557708f21b9 | c124c2e8-6b24-4a3a-b70a-3738fc9abe7c | vehicle_followup | Elaine Borges de oliveira | 2026-09-14 13:21:19.093+00 | 0.1 |
| c1251fb3-38a6-4e41-88d3-aad1391005aa | 34167613-aff9-4b8e-bd4d-8df90b2e1b4a | return_customer | Eduardo Soares | 2026-09-14 14:30:58.36+00 | 0.1 |
| 00dc4ae4-1e2b-4fda-90fa-936e2e50e91a | ebaddc92-6b24-4137-8287-824f26deb9fe | customer_unresponsive | ... | 2026-09-22 19:38:25.025+00 | 0.1 |
| 63f1e061-ccc1-4c58-9f9f-a0b1764e623c | 6386b15b-8747-4c6a-84ff-e436f2c13345 | customer_unresponsive | fabiooliveiradk48 | 2026-09-22 20:00:12.715+00 | 0.1 |
| f921d92e-34c2-40e3-834c-af603e6a05dc | bac356dc-f9ab-48e8-bc44-c1db1db9111c | return_customer | R | 2026-09-14 14:02:13.03+00 | 0.1 |
| e3a0ca0e-36f7-447e-bf58-00b2d441c050 | 89d9820d-03a8-4ddb-8567-f4c49fcffe1f | customer_unresponsive | Binha Jose | 2026-09-14 15:08:43.428+00 | 0.1 |
| b66a6285-d83c-48a1-bbbf-090e049e21fe | 0745d0cb-d7f9-48a3-b8a1-9c41e0038e01 | consortium_followup | .. | 2026-09-14 14:02:35.77+00 | 0.1 |
| aa2f3e07-c4bc-428b-b4ab-2cfac817e32a | 5999567a-2daf-4fea-bae2-8af77445ce22 | return_customer | Ronilson | 2026-09-14 14:04:52.81+00 | 0.1 |
| 6172a445-daaa-4336-a6b3-d737f46b12c5 | 89d9820d-03a8-4ddb-8567-f4c49fcffe1f | return_customer | Binha Jose | 2026-09-14 15:08:43.428+00 | 0.1 |
| ac793451-f19d-4559-bf64-b94866efee8f | fb7d1de1-de64-493f-943a-44f49c02eb11 | consortium_followup | LIH 🩷 | 2026-09-14 15:15:23.198+00 | 0.1 |
| 02999b98-27f2-41d3-bdca-eb7c58978938 | 4bab8ff4-49e6-42ed-b061-55fbdb989e99 | return_customer | Familia 🥰 | 2026-09-14 15:37:30.395+00 | 0.1 |
| f96140ec-9c00-4775-a3e4-6c3e11f297ec | f38af69c-8845-4880-827e-d26f2075b3c5 | customer_unresponsive | Renata &Maria Isabel | 2026-09-14 19:17:17.801+00 | 0.1 |
| 2e53d7b5-b6d8-407a-b6b4-600c73d0bdbc | 3029f124-174b-44d5-aeaf-debda0ddb0ff | return_customer | Gedson Farias | 2026-09-14 15:17:50.629+00 | 0.1 |
| b9800b24-ad36-4db3-9785-ea99de666c2d | b1e64fdb-4570-451f-8f25-7bb08ee74fbd | customer_unresponsive | Felipe Oliveira Resende | 2026-09-22 18:20:39.993+00 | 0.1 |
| 46582d72-7ce5-477b-be49-cc186ebe53d8 | 99c5320f-1144-4a8a-8d5e-c3ead4abe148 | financing_followup | Kamilla | 2026-09-14 15:22:36.632+00 | 0.1 |
| cfe57809-8e31-461f-befa-1134b506a9fc | 4bab8ff4-49e6-42ed-b061-55fbdb989e99 | customer_unresponsive | Familia 🥰 | 2026-09-14 15:37:30.395+00 | 0.1 |
| 6e65d547-a435-49d4-a1d0-7af040f43181 | 2997e2e6-5948-4a7e-be13-700b2d3ac376 | run_quote | Scheila | 2026-09-14 16:02:37.385+00 | 0.1 |
| 33111bfa-1748-40f9-9abb-8ad9b97606bc | 2997e2e6-5948-4a7e-be13-700b2d3ac376 | financing_followup | Scheila | 2026-09-14 16:02:37.385+00 | 0.1 |
| 96f21d99-8250-425f-826b-170154d14d96 | 198f05da-876f-455f-9095-0d7b3d758928 | customer_unresponsive | Antônio Rosa | 2026-09-19 13:28:45.852+00 | 0.1 |
| 9714a752-8c7f-465e-86f8-69b59a4faba9 | f38af69c-8845-4880-827e-d26f2075b3c5 | consortium_followup | Renata &Maria Isabel | 2026-09-14 19:17:17.801+00 | 0.1 |
| 120c2c55-86dd-4eca-a7a4-e597c0ad1f65 | 5613b97d-aa1e-4481-b20b-f63dbc3d9b20 | vehicle_followup | Pedrokka | 2026-09-14 19:52:01.703+00 | 0.1 |
| 0f475f06-f5dd-4d7c-82e4-fb500b636d32 | a0ce6508-bc51-415f-8ee3-947e1a6f7ee3 | consortium_followup | Edson barreto | 2026-09-14 19:26:34.522+00 | 0.1 |
| 17fb5189-47f2-45e1-b7b3-c9b957b06d35 | bf69987c-2bd4-4c19-8f5c-0ec331b18e3d | run_quote | Josiel | 2026-09-14 19:25:41.627+00 | 0.1 |
| 908a95d1-279b-4e5d-884d-4e710d8747d4 | bf69987c-2bd4-4c19-8f5c-0ec331b18e3d | financing_followup | Josiel | 2026-09-14 19:25:41.627+00 | 0.1 |
| 492fe16a-36fb-4ed8-9273-5c2477ab444a | a0ce6508-bc51-415f-8ee3-947e1a6f7ee3 | customer_unresponsive | Edson barreto | 2026-09-14 19:26:34.522+00 | 0.1 |
| 9f80974a-f67d-4935-a596-23213e61dce1 | e5644444-a511-4755-b2ba-e3e64b0386fe | run_quote | cleiberfrancisco26 | 2026-09-14 19:28:25.055+00 | 0.1 |
| c95bbeb8-e2a0-4442-a6fa-b7a7ccbff829 | e5644444-a511-4755-b2ba-e3e64b0386fe | customer_unresponsive | cleiberfrancisco26 | 2026-09-14 19:28:25.055+00 | 0.1 |
| 39475662-7397-49e6-b739-86b30aba5583 | e5644444-a511-4755-b2ba-e3e64b0386fe | proposal_followup | cleiberfrancisco26 | 2026-09-14 19:28:25.055+00 | 0.1 |
| f085a7eb-51ab-470a-afd5-d77f689906ac | 2d643894-ca44-4827-b70a-7c18982c66d1 | customer_unresponsive | Elizeth 🌶️ | 2026-09-15 14:38:55.466+00 | 0.1 |
| a65554c9-e509-466b-b007-e9fdd4f8cca6 | 4abad23b-93a1-47df-b0d0-0516f637a8ee | vehicle_followup | Deus | 2026-09-22 20:14:21.073+00 | 0.1 |
| b90f229d-7b00-4fae-b753-72413e132ad6 | 68f5c249-1600-4f80-953e-ff980ceecfe8 | return_customer | João Paulo | 2026-09-17 14:18:54.534+00 | 0.1 |
| 72506c72-5631-4975-b5c6-14dc795a0f10 | 47ac54aa-6474-4f3c-b4a3-4926174cf7e8 | customer_unresponsive | didi | 2026-09-18 13:19:49.108+00 | 0.1 |
| e43fc9ee-56b2-4539-bcfb-1fe3b0979e7a | 970140e6-256c-4474-bee1-3f09df082590 | customer_unresponsive | joseluizpitoco123 | 2026-09-22 19:13:35.53+00 | 0.1 |
| 10140883-981e-44ca-831b-2b6b54c68fe4 | e6327171-2212-4386-bbe2-51641264a489 | customer_unresponsive | 😝 | 2026-09-18 13:29:30.314+00 | 0.1 |
| 1ca1c68e-e135-4c33-8321-86c4276f79cd | 48b9a4cb-9854-4f26-801d-913e6cc67126 | customer_unresponsive | Damasceno | 2026-09-18 13:31:35.592+00 | 0.1 |
| b3d8359c-3dba-4186-826d-a6eb64a75f20 | 8625684c-871f-4c3b-9b15-0737a390c8b8 | return_customer | Amadeu Braz Q filho | 2026-09-14 14:09:25.065+00 | 0.2 |
| 4c6482d4-b682-40d7-9b37-fa799529f8cd | 27e1ff5d-01ca-42c9-9539-fcd2358da6c2 | vehicle_followup | Gildasio | 2026-09-21 15:21:42.067+00 | 0.2 |
| 156ef355-cd89-4497-aac3-23e71ca7ebf2 | 12e96c3d-c1b0-402c-9873-6d922ad519a0 | customer_unresponsive | Paloma Menezes | 2026-09-15 18:27:09.662+00 | 0.2 |
| daffecd7-1c38-4bbe-bdbd-bd361eb171dc | 586ea338-97f1-44ae-9034-09493b370472 | proposal_followup | jairo carvalho | 2026-09-21 20:51:06.492+00 | 0.2 |
| 1dfd97b8-c238-453c-9f19-b776118a362d | 40f74a2f-f897-480e-8a91-73b54c1670b6 | customer_unresponsive | lucivaldodasilvarodrigues | 2026-09-14 13:23:38.026+00 | 0.2 |
| 98c137c2-da5d-4040-a833-31de1e30b7f4 | 40f74a2f-f897-480e-8a91-73b54c1670b6 | return_customer | lucivaldodasilvarodrigues | 2026-09-14 13:23:38.026+00 | 0.2 |
| 45b8926d-7372-4325-a6ef-638641abd72d | 9ad080fe-3df6-4b3e-9b77-2f34b1667b65 | consortium_followup | Gomes | 2026-09-14 13:24:28.931+00 | 0.2 |
| d8cbe954-262b-48d9-a4e5-347e23bc652d | 1ca99be4-f9b0-4833-a69d-f894cd935dae | financing_followup | mikaelkawz | 2026-09-22 13:51:05.31+00 | 0.2 |
| 56d30cbe-480b-455d-a3f1-9873981989b6 | 1ca99be4-f9b0-4833-a69d-f894cd935dae | run_quote | mikaelkawz | 2026-09-22 13:51:05.31+00 | 0.2 |
| 7efb9479-754d-4943-ab37-1839097dbf55 | 024a1166-72f6-4b83-a073-8a04bf53cd00 | customer_unresponsive | . | 2026-09-14 13:54:39.734+00 | 0.2 |
| 9c399dca-7c0b-4d64-9267-ac2b25e9ec77 | 60164d3a-b9c0-4cab-8416-af7e75e03ed3 | customer_unresponsive | viniciusataide2019 | 2026-09-21 15:27:23.68+00 | 0.2 |
| 2479a315-6764-48f3-a337-57b3dca4ecd5 | a0f82d92-7141-434e-81e6-9188064891d7 | customer_unresponsive | Lucas Gomes | 2026-09-16 14:17:13.092+00 | 0.2 |
| ef69e242-9c42-4b72-92e5-605fbe710d73 | 9f2c60ef-a1d8-4de5-b2fe-effd31099280 | customer_unresponsive | MOREIRA | 2026-09-14 14:04:34.368+00 | 0.2 |
| b889fd57-3bfc-45bc-9f76-ec32d7810a1d | 9f2c60ef-a1d8-4de5-b2fe-effd31099280 | return_customer | MOREIRA | 2026-09-14 14:04:34.368+00 | 0.2 |
| 98578d54-c48b-4465-a527-9a80b590726f | a0f82d92-7141-434e-81e6-9188064891d7 | return_customer | Lucas Gomes | 2026-09-16 14:17:13.092+00 | 0.2 |
| 53449d02-63e1-41d6-a965-e1c17765b502 | a0f82d92-7141-434e-81e6-9188064891d7 | consortium_followup | Lucas Gomes | 2026-09-16 14:17:13.091+00 | 0.2 |
| de543f0b-205f-4b25-ab05-3c4f35907767 | 7a5e87dc-1456-4de0-b3d7-86e892d772d9 | financing_followup | Gabriel Santos | 2026-09-18 13:23:27.938+00 | 0.2 |
| 9e198c68-2772-4cfb-9d95-0e600e5c2936 | 7a5e87dc-1456-4de0-b3d7-86e892d772d9 | run_quote | Gabriel Santos | 2026-09-18 13:23:27.938+00 | 0.2 |
| 2f852b50-9fc2-401d-9b32-788e7a737c32 | a66022c6-1424-45bd-a472-f92b14202897 | run_quote | Nivaldo | 2026-09-16 15:16:20.442+00 | 0.2 |
| 254e710f-08f7-472a-ba34-09294a4206ee | a66022c6-1424-45bd-a472-f92b14202897 | vehicle_followup | Nivaldo | 2026-09-16 15:16:20.442+00 | 0.2 |
| e9d5b339-2f78-4a5c-b91d-df0fefd39b06 | f00f6f2a-8c25-4fac-a2f3-b9fe4b72070e | consortium_followup | Adimar Alves | 2026-09-21 15:26:16.696+00 | 0.2 |
| 43dcedce-1883-414e-94a8-dc19149ba7d4 | 8625684c-871f-4c3b-9b15-0737a390c8b8 | customer_unresponsive | Amadeu Braz Q filho | 2026-09-14 14:09:25.065+00 | 0.2 |
| 1343597f-544b-46aa-9d78-503f6250d2ab | f439d204-6205-4593-880c-ebc45aa6855b | run_quote | 😎 | 2026-09-16 20:16:22.313+00 | 0.2 |
| 0784c562-00e2-487e-b3b4-caa9eb392a97 | 825b1fb6-e40a-446a-bc6e-3e0655df583a | consortium_followup | André Luiz Alves Da Silva | 2026-09-16 20:36:30.092+00 | 0.2 |
| 00b93676-28ee-4bcc-b893-932b8d025ede | 586ea338-97f1-44ae-9034-09493b370472 | customer_unresponsive | jairo carvalho | 2026-09-21 20:51:06.492+00 | 0.2 |
| e42b1418-3c7c-46b7-ab18-a01a5f37af48 | 75dc43b1-004b-4f10-9f1c-2cad5b496f21 | customer_unresponsive | Welly | 2026-09-22 12:34:24.303+00 | 0.2 |
| 300695e7-5444-41d9-b4f7-771d88eb3289 | f439d204-6205-4593-880c-ebc45aa6855b | financing_followup | 😎 | 2026-09-16 20:16:22.313+00 | 0.2 |
| 8ef15041-0a36-482e-877d-da7a9d563a5b | 4b45d3e5-3ccf-4d23-88e1-7441a8e5b252 | customer_unresponsive | Sousa🎶 | 2026-09-21 15:24:05.322+00 | 0.2 |
| 500402c3-bdf9-470e-a1d7-48c2eb42944e | dda51555-2c44-4506-84e8-49f3749a0ca6 | financing_followup | Jhessica | 2026-09-21 19:59:25.872+00 | 0.2 |
| c366ce05-51e6-43ba-8fbb-a8eaba439b04 | 8ac49ed4-4d00-4839-968c-e465a72c89ed | financing_followup | Helaine 🥰 | 2026-09-18 11:59:25.397+00 | 0.2 |
| 1609dd75-02dc-4c26-a479-ebd32812014c | 52fc3a3b-5006-406e-ae54-9270821ca137 | consortium_followup | Rosy❤️ | 2026-09-21 13:59:21.848+00 | 0.2 |
| ed263c4d-6de8-4d49-8630-eab34570b7be | 4ce29f74-bd31-4696-9dce-8563448f349d | consortium_followup | Edmar Barbosa | 2026-09-16 21:02:00.899+00 | 0.2 |
| d49e93e9-6b8d-4f47-b031-e54b64f294e0 | 52fc3a3b-5006-406e-ae54-9270821ca137 | return_customer | Rosy❤️ | 2026-09-21 13:59:21.848+00 | 0.2 |
| f5a67ee9-61e6-4faa-b955-f077b1719c22 | 3cf8f38c-3711-4c87-a3f8-29a361ba9f16 | consortium_followup | . | 2026-09-21 14:02:28.034+00 | 0.2 |
| c7d427ed-2e0f-4e83-925a-5a9cd3be5d6c | 562e6b7a-c876-4fbc-b729-7fa0cf48d0ad | financing_followup | W.s | 2026-09-16 20:59:01.584+00 | 0.2 |
| d8fa2d47-b244-4ea1-aec9-6a3183e108d2 | 562e6b7a-c876-4fbc-b729-7fa0cf48d0ad | run_quote | W.s | 2026-09-16 20:59:01.584+00 | 0.2 |
| ed74817a-6b41-49db-bdb9-e83426b54a43 | 105d92e3-b6f1-47ef-bd0d-39c0e4a30acc | consortium_followup | . | 2026-09-14 13:05:07.73+00 | 0.2 |
| 7bd87104-897f-4176-a54c-c537ebedd70e | 4ce29f74-bd31-4696-9dce-8563448f349d | run_quote | Edmar Barbosa | 2026-09-16 21:02:00.899+00 | 0.2 |
| 94a90200-8a08-4ec6-ad98-cda3494b73b3 | ea66bae7-30e7-47db-86d4-f9abfcbf9151 | consortium_followup | . | 2026-09-14 13:01:45.143+00 | 0.2 |
| 33007e7d-d16b-4676-aeab-fc41a4afcfe0 | 7883ae11-0419-4c16-b2ef-2f398d4856fa | consortium_followup | Fábio Costa, Violinista | 2026-09-14 13:03:55.301+00 | 0.2 |
| 9393e6d3-63c0-418f-bde9-7c4df9a5b50a | 75dc43b1-004b-4f10-9f1c-2cad5b496f21 | proposal_followup | Welly | 2026-09-22 12:34:24.303+00 | 0.2 |
| ec953350-9948-49d6-bbf0-3ef17e6dd2f6 | 4b45d3e5-3ccf-4d23-88e1-7441a8e5b252 | return_customer | Sousa🎶 | 2026-09-21 15:24:05.322+00 | 0.2 |
| cce4718a-9b97-4034-a443-0d6b1e4c2d75 | 0a594d5f-1c0b-4fa4-ac0a-033a70a87205 | customer_unresponsive | Abdias Gontijo | 2026-09-22 13:39:10.694+00 | 0.2 |
| 4dc47772-5ace-43a5-a36f-4b69b4477d57 | 13a381b4-8778-43e7-aa5c-a0987b807ecd | consortium_followup | None | 2026-09-21 12:57:23.42+00 | 0.2 |
| 807fa721-cac2-4f4e-991f-07abbb895898 | c3d01208-68f4-4b01-879d-c1153856098a | customer_unresponsive | Luiz Henrique | 2026-09-21 12:43:26.159+00 | 0.2 |
| 90f2701c-70fe-49b3-8dff-2522857a6e18 | c07bf945-3f93-4d85-b358-e09dbb523b14 | scheduled_callback | Alberto Benevides | 2026-09-22 13:54:32.721+00 | 0.2 |
| 73168efa-55ff-4fb2-aeca-51688069fb96 | aaa20667-1ba6-4962-8117-1b409974a1bb | return_customer | None | 2026-09-22 10:58:40.043+00 | 0.2 |
| 64bc02c7-d61b-4d26-9992-fec90bebe69c | b0f6fe1e-7e66-49ea-b7da-be58c715be36 | customer_unresponsive | ~Ysabella💗 | 2026-09-22 14:53:10.09+00 | 0.2 |
| e73beaa7-4d8e-4ae4-a2cb-8ae78e6c3c40 | aaa20667-1ba6-4962-8117-1b409974a1bb | customer_unresponsive | None | 2026-09-22 10:58:40.043+00 | 0.2 |
| 1a7ed672-899b-4385-a067-a6a04c9d31a8 | 9e552733-94d4-4b7b-8d54-e7473e3f5060 | return_customer | Andre Moreira | 2026-09-21 14:28:41.314+00 | 0.2 |
| 102eb8c2-28f9-429a-9de1-d52c198dfb74 | 2b216f53-03ff-4d45-9e9d-ff80693db72d | consortium_followup | 🙏.VAMOS.NA.FÉ.🙏 | 2026-09-22 12:42:23.431+00 | 0.2 |
| 06800ba5-d1bf-422f-8a0f-93ce0fe3d16d | 7124d483-2495-4757-a78d-b1ecbaf3a715 | customer_unresponsive | Marli | 2026-09-22 13:22:41.914+00 | 0.2 |
| 2e315d3a-5f8b-4431-946a-a5308dc70c2f | e47731d7-7e64-4650-b473-822c99b6b915 | proposal_followup | Claudemir Pinto de morais | 2026-09-17 14:58:59.335+00 | 0.2 |
| 010e4532-c3d2-4931-8896-000e04a7afe5 | e47731d7-7e64-4650-b473-822c99b6b915 | customer_unresponsive | Claudemir Pinto de morais | 2026-09-17 14:58:59.335+00 | 0.2 |
| aaec062c-cd6b-4207-9a31-bf0d40b0bd10 | ea1d761c-f1e9-4f6a-a9ed-1c8850adb1d8 | customer_unresponsive | Wallefy Juan | 2026-09-14 19:45:45.383+00 | 0.2 |
| 0782c5a0-606f-4c41-ace9-45fd854f53cc | ea1d761c-f1e9-4f6a-a9ed-1c8850adb1d8 | return_customer | Wallefy Juan | 2026-09-14 19:45:45.383+00 | 0.2 |
| c193bd07-be9a-499f-a9ad-16a5e2656ee9 | 0a594d5f-1c0b-4fa4-ac0a-033a70a87205 | return_customer | Abdias Gontijo | 2026-09-22 13:39:10.694+00 | 0.2 |
| bd63eb5a-0440-4142-9f40-1450a500dd90 | b0f6fe1e-7e66-49ea-b7da-be58c715be36 | financing_followup | ~Ysabella💗 | 2026-09-22 14:53:10.09+00 | 0.2 |
| 90c6014a-b048-45d5-afe5-4d7e4534de81 | 1d26c21a-a008-4ae4-8806-6b393827e9b1 | customer_unresponsive | jj | 2026-09-18 18:34:04.993+00 | 0.2 |
| 4c7ef509-72c2-45ab-b2a0-d540cfd52f06 | ea1d761c-f1e9-4f6a-a9ed-1c8850adb1d8 | financing_followup | Wallefy Juan | 2026-09-14 19:45:45.383+00 | 0.2 |
| 74b8af7e-cfce-4dc1-8f3c-c408c16cbbb0 | 1d26c21a-a008-4ae4-8806-6b393827e9b1 | consortium_followup | jj | 2026-09-18 18:34:04.993+00 | 0.2 |
| 7c5218af-162f-433c-bd9e-652810e73f4b | 27e1ff5d-01ca-42c9-9539-fcd2358da6c2 | customer_unresponsive | Gildasio | 2026-09-21 15:21:42.067+00 | 0.2 |
| 312c539c-1d96-49b2-a061-ab989e3dbe69 | 18da8edb-a9c2-46a3-a08f-2da683d65ff5 | customer_unresponsive | Jair | 2026-09-21 12:07:10.533+00 | 0.2 |
| 2b11e8e3-9228-4473-a078-dc005ec66226 | 7ebed362-3112-4344-ae88-f963e112ea43 | customer_unresponsive | chefinho | 2026-09-17 19:47:53.425+00 | 0.2 |
| d02a6c62-f8e2-4eff-b304-8acab9ad00d4 | 7ebed362-3112-4344-ae88-f963e112ea43 | return_customer | chefinho | 2026-09-17 19:47:53.425+00 | 0.2 |
| 905afb17-e04f-4820-85fc-992cbfd3acb8 | 18da8edb-a9c2-46a3-a08f-2da683d65ff5 | return_customer | Jair | 2026-09-21 12:07:10.533+00 | 0.2 |
| 0149ccef-f2df-4dee-8fc5-1a11dd10912a | 27e1ff5d-01ca-42c9-9539-fcd2358da6c2 | return_customer | Gildasio | 2026-09-21 15:21:42.067+00 | 0.2 |
| f26b6271-1d4b-4e5a-bf4f-6e1e64172cd2 | ed719c38-308e-4554-b8c0-0f1bdaf0fe1c | vehicle_followup | Marivaldo | 2026-09-21 14:25:15.741+00 | 0.2 |
| ab212f68-fb3f-4375-a7e4-618f92ea823b | 4f32d521-6d7a-426c-a23b-26cadb09f926 | customer_unresponsive | Marcelo Souza | 2026-09-15 14:16:16.093+00 | 0.2 |
| ec77f793-4fa6-48db-80c2-4a8eb00762a3 | 490374dd-f32d-4f2e-9b63-c0491f035939 | awaiting_customer_cpf | Ana Julia ✌🏻❤️ | 2026-09-22 19:44:28.921+00 | 0.2 |
| bb658ccf-b64b-43ef-a70d-2e0ec91b45a5 | 9e552733-94d4-4b7b-8d54-e7473e3f5060 | consortium_followup | Andre Moreira | 2026-09-21 14:28:41.313+00 | 0.2 |
| ae70a993-c43d-4624-bb37-c02bd5bc0a08 | 75dc43b1-004b-4f10-9f1c-2cad5b496f21 | return_customer | Welly | 2026-09-22 12:34:24.303+00 | 0.2 |
| 0b69d824-8b0f-4d05-a78a-2fc66cdb6149 | 9e552733-94d4-4b7b-8d54-e7473e3f5060 | customer_unresponsive | Andre Moreira | 2026-09-21 14:28:41.314+00 | 0.2 |
| d5df78fe-fd76-476c-8dfd-39829aabc49a | 9f58e6f0-edff-40d6-bbab-d239618904b0 | return_customer | 👏🏽 | 2026-09-21 13:05:48.741+00 | 0.2 |
| b0604830-d95a-47a7-af13-edb3374fe0d9 | 12e96c3d-c1b0-402c-9873-6d922ad519a0 | consortium_followup | Paloma Menezes | 2026-09-15 18:27:09.662+00 | 0.2 |
| 201668ce-2add-4715-b522-6175030ea148 | 12e96c3d-c1b0-402c-9873-6d922ad519a0 | run_quote | Paloma Menezes | 2026-09-15 18:27:09.662+00 | 0.2 |
| c061f340-5fcd-464e-a0c9-c7bcc2138dbc | 12e96c3d-c1b0-402c-9873-6d922ad519a0 | financing_followup | Paloma Menezes | 2026-09-15 18:27:09.662+00 | 0.2 |
| 43411ac8-7d05-4aa4-bb0e-03223c90ea0c | 8ac49ed4-4d00-4839-968c-e465a72c89ed | run_quote | Helaine 🥰 | 2026-09-18 11:59:25.397+00 | 0.2 |
| 0ac34455-0d35-4aa9-861d-e987c93402d6 | 476c1af6-a3a8-439e-88b4-96df44ec77cb | return_customer | Vt Santos | 2026-09-12 13:30:54.248+00 | 0.2 |
| c4140e08-321f-4d7a-98d2-1874060f6918 | fe5373fe-165b-4b01-b6db-08e1dd00157d | consortium_followup | Leandro Santos | 2026-09-21 15:29:28.202+00 | 0.2 |
| 76213c4b-1536-401c-80f2-3c79e639c2fb | 200fbedf-8efa-42b5-8501-98a37bce6ecb | customer_unresponsive | vg_cleverton 🍃 | 2026-09-21 14:43:44.943+00 | 0.2 |
| 052e18b1-d871-4ca7-99d3-153758a5aea7 | 49f0e6cc-4eb2-43ed-af20-94e485163631 | run_quote | Valdeci | 2026-09-17 15:35:45.915+00 | 0.2 |
| 43e57f64-fd74-4453-b382-8c867a0fb0fe | 8d73b73b-1a87-4b9d-90e6-0428247a6804 | customer_unresponsive | marcio | 2026-09-16 13:09:23.573+00 | 0.2 |
| d9cbb0bd-48ff-4f7c-823a-55830ff4684a | ceee8e3c-0290-4ffa-a96a-e7954b12ce72 | consortium_followup | marcoscelsodecarvalho@gma | 2026-09-21 15:57:25.759+00 | 0.2 |
| 3a875538-fb72-4dc5-8f50-00d45f9eb5ef | 40b08ce3-168b-4c0e-9c6e-f0adcb602922 | consortium_followup | Renato | 2026-09-21 21:01:02.724+00 | 0.2 |
| 7ee4998d-2649-4e88-92a1-76604c359d53 | 7b45324a-3eed-4852-a6f5-0b95063098a4 | run_quote | Salve | 2026-09-17 21:25:50.751+00 | 0.2 |
| 33f341b6-25e5-4aa2-8f0b-b445a27d30db | 7b45324a-3eed-4852-a6f5-0b95063098a4 | awaiting_customer_decision | Salve | 2026-09-17 21:25:50.751+00 | 0.2 |
| c48d4a59-5308-4e39-8d0b-b095583c4124 | 3484680a-aa24-46ce-8a2c-1727aadde654 | return_customer | Gleidson Ramos 🎸🎤 | 2026-09-16 10:52:45.42+00 | 0.2 |
| cadd292b-bc32-4cf2-b8da-1981f781dfb8 | 7b45324a-3eed-4852-a6f5-0b95063098a4 | customer_unresponsive | Salve | 2026-09-17 21:25:50.751+00 | 0.2 |
| 00c8796c-0607-4588-80dd-ced5c4338e09 | 7c2dd93e-951a-4646-a4e4-f6e6ca567ef9 | consortium_followup | Chagas Alves | 2026-09-15 12:15:11.379+00 | 0.2 |
| a8fedd17-8e44-4915-8896-66df77f9c591 | 476c1af6-a3a8-439e-88b4-96df44ec77cb | customer_unresponsive | Vt Santos | 2026-09-12 13:30:54.248+00 | 0.2 |
| 0733885e-d353-4c36-8ecc-ac084920ffef | afe92ed9-ae6f-4faf-8fb5-8bdbb554022d | stalled_negotiation | Erisvaldo | 2026-09-12 14:01:28.02+00 | 0.2 |
| 1bd959ce-2fac-4c5e-83a1-9bf0dfa0add7 | 0d5e5609-a378-40cf-9a3e-3080a1599346 | run_quote | Thiago 😎😉 | 2026-09-16 10:54:32.928+00 | 0.2 |
| 1bffa57e-3133-4727-8026-302af7be5930 | 430122eb-3219-4514-8ae9-69f672637e02 | customer_unresponsive | Mosair | 2026-09-16 13:30:36.371+00 | 0.2 |
| 30a0377c-8693-4240-ba68-9785c19ae078 | 49f0e6cc-4eb2-43ed-af20-94e485163631 | customer_unresponsive | Valdeci | 2026-09-17 15:35:45.915+00 | 0.2 |
| 6fb95dce-4c54-4896-a3e3-4b79fd94c317 | 53d1b549-6c7a-4b1e-9e31-ef114f232505 | run_quote | Kamylla Gonçalves | 2026-09-17 21:28:16.703+00 | 0.2 |
| d6d86b58-0dd0-4bc6-a296-e88d3adf2ff4 | a66033f6-5244-43ec-95b2-8cd2b43ad9fc | consortium_followup | j Adriano | 2026-09-14 14:10:36.358+00 | 0.2 |
| c78f0c34-d497-4179-8541-c43b515cfb71 | a66033f6-5244-43ec-95b2-8cd2b43ad9fc | customer_unresponsive | j Adriano | 2026-09-14 14:10:36.358+00 | 0.2 |
| 5ab9220b-8dbd-48ea-81ca-7ad748ccdf92 | 49f0e6cc-4eb2-43ed-af20-94e485163631 | return_customer | Valdeci | 2026-09-17 15:35:45.915+00 | 0.2 |
| 02d7b46d-e92e-41f3-ac81-9b67c895d139 | 151e746a-3a8f-4abc-abd9-b688b9a1488a | consortium_followup | Lucasdias | 2026-09-16 11:10:19.241+00 | 0.2 |
| f462abc0-7d38-4f1b-948f-09dba9042ec6 | a89a4bd6-75a1-474a-8a17-9216f8c8e40e | consortium_followup | Joker🖤 | 2026-09-10 18:53:06.264+00 | 0.2 |
| 9339ee8b-857c-4fab-b814-d1e9e3e61356 | ed719c38-308e-4554-b8c0-0f1bdaf0fe1c | customer_unresponsive | Marivaldo | 2026-09-21 14:25:15.741+00 | 0.2 |
| 67e7c119-4bcb-4643-988c-b924b55de4dc | 476c1af6-a3a8-439e-88b4-96df44ec77cb | consortium_followup | Vt Santos | 2026-09-12 13:30:54.248+00 | 0.2 |
| a9e38dce-0847-4570-a10f-273bf4f1953b | 7b45324a-3eed-4852-a6f5-0b95063098a4 | financing_followup | Salve | 2026-09-17 21:25:50.751+00 | 0.2 |
| c04f9e27-6a2b-4faf-b3a6-596b627a4ade | 8d73b73b-1a87-4b9d-90e6-0428247a6804 | financing_followup | marcio | 2026-09-16 13:09:23.573+00 | 0.2 |
| 0e3ad297-8f36-4603-bd92-6bdadfc54ad3 | 8d73b73b-1a87-4b9d-90e6-0428247a6804 | run_quote | marcio | 2026-09-16 13:09:23.573+00 | 0.2 |
| 839b50d8-f8c9-4769-8b37-800ccbc9085f | 905bfec1-1eb4-4486-b744-4567a63629d4 | consortium_followup | Fellipe | 2026-09-21 15:49:46.055+00 | 0.2 |
| f4c934a8-6690-4613-9b81-ad042826ce21 | 330c1a43-d41f-4084-9207-d588d65ae5dd | customer_unresponsive | jean Carlos | 2026-09-21 14:48:11.328+00 | 0.2 |
| c1fe1544-0724-4906-b94f-60df804bd4b7 | 1d26c21a-a008-4ae4-8806-6b393827e9b1 | return_customer | jj | 2026-09-18 18:34:04.993+00 | 0.2 |
| 34f90ad5-b6e8-4be2-a415-e34e57132d32 | e46d80e6-57ea-45b1-b03b-25f155f78a2b | customer_unresponsive | Adão mecânico | 2026-09-12 14:18:32.389+00 | 0.2 |
| 6307e7fb-35df-4eb1-adce-b90f4892bd46 | 68c142fa-35a5-4fbd-9828-acf70481ca8c | customer_unresponsive | March Jhermany | 2026-09-14 13:11:21.861+00 | 0.2 |
| 68e6e160-e72b-4fca-a3b7-d7b461f67d3b | 68c142fa-35a5-4fbd-9828-acf70481ca8c | vehicle_followup | March Jhermany | 2026-09-14 13:11:21.86+00 | 0.2 |
| c15614ba-4f6b-4b22-91ef-ab6cf043132d | 52fc3a3b-5006-406e-ae54-9270821ca137 | customer_unresponsive | Rosy❤️ | 2026-09-21 13:59:21.848+00 | 0.2 |
| 57d80d3a-56ba-4f58-ac27-5be7199b8f8b | 109863d8-17da-4605-8d02-f138450e45ef | consortium_followup | ronaldomotocenter | 2026-09-14 13:09:28.444+00 | 0.2 |
| 2b9a5821-391c-41eb-a4ea-e77ab1ef7f8e | 7ebed362-3112-4344-ae88-f963e112ea43 | proposal_followup | chefinho | 2026-09-17 19:47:53.425+00 | 0.2 |
| 2e197537-9d0d-4836-984d-de855f95e6e3 | 53d1b549-6c7a-4b1e-9e31-ef114f232505 | financing_followup | Kamylla Gonçalves | 2026-09-17 21:28:16.703+00 | 0.2 |
| 551350a2-48c7-4ccf-8448-baa3d5ec6f6f | 2ce2d60b-c504-404f-a6a0-e5ffc0d10df0 | other | algustojose138 | 2026-09-16 13:24:16.773+00 | 0.2 |
| a90b62e4-93a0-4548-b106-e6b23ae0fe86 | 03b7f56e-f043-429b-9161-bf97d7e83bb3 | run_quote | Dany Teclas | 2026-09-21 12:38:11.196+00 | 0.2 |
| 8029058c-bc35-4156-adf3-5561d91e8535 | dda51555-2c44-4506-84e8-49f3749a0ca6 | run_quote | Jhessica | 2026-09-21 19:59:25.872+00 | 0.2 |
| 26177dbf-dffa-4ef4-9bb7-5576e38cbb65 | 17758b62-3984-4783-ac79-1ea59478e457 | vehicle_followup | Clarete | 2026-09-11 18:48:26.655+00 | 0.2 |
| 83392319-db65-4da6-be06-2b28f7d00d64 | 6cabc84e-1934-4dd8-8ebc-5a70233a07be | proposal_followup | arley | 2026-09-11 18:56:21.739+00 | 0.2 |
| eba9abd0-e6a8-4f91-803a-ae9dce8c7337 | 31c90774-8c73-44bb-9e82-06964464c70d | consortium_followup | Alice | 2026-09-11 18:51:35.765+00 | 0.2 |
| cddf48eb-06a9-4524-9277-f7ba2fcfe3b0 | 6f86bd9c-de2f-4ec3-bb68-5604dc45d09a | return_customer | Nildivânia Castro | 2026-09-11 19:00:55.309+00 | 0.2 |
| c06e5385-2a04-41a4-8522-3cada980fd55 | e46d80e6-57ea-45b1-b03b-25f155f78a2b | return_customer | Adão mecânico | 2026-09-12 14:18:32.389+00 | 0.2 |
| 4f78f673-b230-4f59-835d-8e5d1c49b96e | 4ab43b60-625c-43e8-9ddf-185688e6a1c9 | vehicle_followup | Danilo🇧🇷 | 2026-09-11 19:12:12.688+00 | 0.2 |
| 558086f3-01fc-43b8-900a-b41a11c9847e | f0dca160-4398-446c-b39e-7e7acf2fbf8b | customer_unresponsive | Ricardo Soares | 2026-09-11 19:19:42.989+00 | 0.2 |
| f360ce7f-7268-4509-bed2-3a80cee9091a | 49352c5d-63a9-4b7c-a71a-e17bb44c88e4 | customer_unresponsive | Cláudio Magalhães | 2026-09-16 11:28:55.29+00 | 0.2 |
| e22d3534-40b3-41c6-8eaa-67f8dbae9a2e | 490374dd-f32d-4f2e-9b63-c0491f035939 | run_quote | Ana Julia ✌🏻❤️ | 2026-09-22 19:44:28.921+00 | 0.2 |
| 75d04f2a-e996-4c35-9d07-c6dd9fd6035b | 200fbedf-8efa-42b5-8501-98a37bce6ecb | return_customer | vg_cleverton 🍃 | 2026-09-21 14:43:44.943+00 | 0.2 |
| be8d590f-1c04-4c28-8d76-38df43ad38b7 | e46d80e6-57ea-45b1-b03b-25f155f78a2b | run_quote | Adão mecânico | 2026-09-12 14:18:32.389+00 | 0.2 |
| 8671f5d4-5b85-4f21-a02f-5319330f0712 | 03b7f56e-f043-429b-9161-bf97d7e83bb3 | financing_followup | Dany Teclas | 2026-09-21 12:38:11.196+00 | 0.2 |
| 18045971-427f-4604-9eef-dc75b3c19b60 | 2ce2d60b-c504-404f-a6a0-e5ffc0d10df0 | return_customer | algustojose138 | 2026-09-16 13:24:16.773+00 | 0.2 |
| 23780d6f-e98f-4963-987f-44d137fa1378 | 430122eb-3219-4514-8ae9-69f672637e02 | proposal_followup | Mosair | 2026-09-16 13:30:36.371+00 | 0.2 |
| 737b8f18-f9a6-4d5b-898b-4886ae1a08c0 | 3b349ff7-0bd7-42e8-8b61-897ca6f18e08 | awaiting_customer_cpf | Juares Araújo | 2026-09-16 13:31:53.749+00 | 0.2 |
| a874e3d6-ce2d-49dd-a31c-78224ac96d3d | 7883ae11-0419-4c16-b2ef-2f398d4856fa | other | Fábio Costa, Violinista | 2026-09-14 13:03:55.301+00 | 0.2 |
| 81e589f3-a494-442e-b1a3-56e16fb02652 | 4b45d3e5-3ccf-4d23-88e1-7441a8e5b252 | consortium_followup | Sousa🎶 | 2026-09-21 15:24:05.322+00 | 0.2 |
| 6375d856-4b8b-4d48-8e8b-ad5253a5235b | 024a1166-72f6-4b83-a073-8a04bf53cd00 | return_customer | . | 2026-09-14 13:54:39.735+00 | 0.2 |
| 69f412df-79a7-4daf-87d5-ee427e3fb186 | 0d5e5609-a378-40cf-9a3e-3080a1599346 | financing_followup | Thiago 😎😉 | 2026-09-16 10:54:32.928+00 | 0.2 |
| 532d0a71-8d7f-4294-992f-2bbff8a0359d | 3b349ff7-0bd7-42e8-8b61-897ca6f18e08 | customer_unresponsive | Juares Araújo | 2026-09-16 13:31:53.749+00 | 0.2 |
| 8cd57eb0-1db3-42dd-9a0d-89856515752d | c3d01208-68f4-4b01-879d-c1153856098a | awaiting_customer_cpf | Luiz Henrique | 2026-09-21 12:43:26.159+00 | 0.2 |
| 00b3a798-9a1f-43f2-8017-f0dc870b9e44 | ac88e2fd-163c-483e-a8b0-30b9864bdfbf | proposal_followup | Luiz Carlos Da Silva | 2026-09-16 13:45:20.584+00 | 0.2 |
| c97caed2-f5c1-455b-9188-c2356cc43a7b | ac88e2fd-163c-483e-a8b0-30b9864bdfbf | customer_unresponsive | Luiz Carlos Da Silva | 2026-09-16 13:45:20.584+00 | 0.2 |
| d0cecc31-82c2-49ce-b2d0-a0f7ca086f57 | d639eea2-c4fd-44ff-85a1-ab54a483cc75 | consortium_followup | Alba Lúcia | 2026-09-16 13:46:22.678+00 | 0.2 |
| fe03c028-d06b-4a43-aa89-7c736a3c5ced | c60b3f47-1bb4-4391-8055-9a0504b84bcb | customer_unresponsive | Geovane S. De Jesus | 2026-09-22 20:19:35.16+00 | 0.2 |
| 9f3f036e-767a-4ad1-b453-7e5093917ad7 | 4a365fc6-c563-44a5-b42f-0d7df99b4b8c | proposal_followup | Júnior | 2026-09-21 13:50:26.074+00 | 0.2 |
| 2d9b6d12-180a-4d74-8060-db7165ea81d3 | 8d73b73b-1a87-4b9d-90e6-0428247a6804 | return_customer | marcio | 2026-09-16 13:09:23.573+00 | 0.2 |
| c7e85f1c-87c9-4ff5-93a5-2a79f2bfaa51 | 04a098f2-6ef6-4b6b-b751-d2a10fae0c6c | consortium_followup | Alessandro | 2026-09-21 13:52:20.115+00 | 0.2 |
| 1915b5e5-0fc6-4075-b63a-1753476b45e0 | 96db6b09-64c8-4f1d-8068-fc7f657356b2 | vehicle_followup | Gabi | 2026-09-16 15:11:30.347+00 | 0.2 |
| 252648a6-22a6-416b-a74d-1b32f13d840b | a6d14d71-3ddb-4a1d-8d2b-c7cb36d6b9c3 | customer_unresponsive | Como Fênix 🐦‍🔥 | 2026-09-21 14:49:22.629+00 | 0.2 |
| 12585adc-c81a-429e-8b65-ca5fdb9e3fb9 | b1e64fdb-4570-451f-8f25-7bb08ee74fbd | return_customer | Felipe Oliveira Resende | 2026-09-22 18:20:40.161+00 | 0.3 |
| 1be2c44e-e249-423d-b60e-0e4dbda5f7e9 | 97bd2080-30b2-47e4-8209-53d521082fea | consortium_followup | Francisco | 2026-09-12 14:09:42.248+00 | 0.3 |
| 29ab75fd-b306-4924-85be-f988763182d4 | 9a811b42-9dad-4ba2-bb08-0462284ce125 | vehicle_followup | Paulo Felix | 2026-09-18 18:46:42.062+00 | 0.3 |
| 57409e8b-515b-41e4-9338-31db3cc1bb69 | 9a811b42-9dad-4ba2-bb08-0462284ce125 | customer_unresponsive | Paulo Felix | 2026-09-18 18:46:42.061+00 | 0.3 |
| 5029d8e7-8c5d-4b2d-b9f7-c61be1c3f848 | 6b0819f9-abba-406c-a181-94d6621449dc | consortium_followup | Edis Brito Dos Santos | 2026-09-15 13:33:14.178+00 | 0.3 |
| 5ba9e2ad-819a-417e-98d9-6678fc3e24c0 | 8092d668-67e0-4c8c-9728-1c7784e3d06d | customer_unresponsive | Francisco Silva | 2026-09-12 12:36:03.505+00 | 0.4 |
| 8d6b0721-4669-4dec-9ce4-fac585e0cf96 | 8092d668-67e0-4c8c-9728-1c7784e3d06d | return_customer | Francisco Silva | 2026-09-12 12:36:03.505+00 | 0.4 |
| 00b60ebb-ee84-40a3-8d15-d666b1ebe4f7 | 8092d668-67e0-4c8c-9728-1c7784e3d06d | proposal_followup | Francisco Silva | 2026-09-12 12:36:03.505+00 | 0.4 |
| 935542d3-3851-4342-adc6-34285a971669 | bfd5eca8-e2e0-4a7b-ac0f-c34267c9c116 | other | Messias Jose | 2026-09-18 13:37:24.375+00 | 0.5 |
| e6bd235e-fbc0-48a7-9a48-22a71786ca64 | 9f54efea-b447-408d-90d8-27c1e1e70c3f | proposal_followup | Elmo Gomes | 2026-09-16 20:53:59.027+00 | 0.6 |
| 02bdf985-c2f1-4c73-8b6c-6ff297cd4527 | 9f54efea-b447-408d-90d8-27c1e1e70c3f | customer_unresponsive | Elmo Gomes | 2026-09-16 20:53:59.027+00 | 0.6 |
| 92517c5d-9de0-45c6-89e8-c3151529afc7 | ef2e793e-324f-43fd-b692-78c6bda71e32 | customer_unresponsive | Adriano | 2026-09-21 14:50:34.159+00 | 0.7 |
| 280c0268-feef-493c-a8b0-77908d7b8c17 | 93a22c2a-2cca-4fd9-955b-eb900c85e5d1 | consortium_followup | ,,, | 2026-09-11 18:40:08.128+00 | 1.4 |
| de1b29e0-7a57-4683-9103-fb1758b2f61e | da2bdd72-bc7e-40e6-a761-25be9c650f64 | customer_unresponsive | Divino Serafim | 2026-09-18 19:49:29.128+00 | 2.4 |
| 729c0c08-5f9c-4f6e-ac94-ee8240931b18 | c60b3f47-1bb4-4391-8055-9a0504b84bcb | consortium_followup | Geovane S. De Jesus | 2026-09-22 20:19:37.333+00 | 2.4 |
| cfaa0758-e7ca-4d1d-a6c1-795f658f401d | 6dc114ba-b477-44a9-a739-ef0f3a31e90f | customer_unresponsive | 😍 | 2026-09-22 20:49:20.974+00 | 2.5 |
| 909a717a-6b47-4fbb-83a3-eb8ea6b07139 | 73457100-5a2b-461a-91cf-14f435f10896 | return_customer | Isaías araujo | 2026-09-22 20:19:10.356+00 | 2.5 |
| 91f48340-2fb1-4529-9b0f-83b5e593153b | 123f4a8c-67c8-444f-b24e-4b559b1825c9 | return_customer | ...... | 2026-09-22 20:28:27.084+00 | 2.6 |
| 85194c5a-5e2e-479b-9ef0-5ca3cab1883c | 4309696d-f6cc-4e80-9adf-6fd3bb3de019 | return_customer | Caio | 2026-09-18 19:49:41.503+00 | 2.8 |
| 04b5c96e-bc76-4b7f-b5f2-d8c4f3ff5e01 | 970140e6-256c-4474-bee1-3f09df082590 | return_customer | joseluizpitoco123 | 2026-09-22 19:13:38.251+00 | 2.9 |
| 902334a4-fef5-4fdb-aafc-5e960a68e3b1 | 8a607af6-719a-47bc-9942-9401fea7e5bd | proposal_followup | Rogerio | 2026-09-22 20:19:23.961+00 | 2.9 |
| cacfa80f-67ad-4ba5-9ff7-d5b94c016111 | 6386b15b-8747-4c6a-84ff-e436f2c13345 | return_customer | fabiooliveiradk48 | 2026-09-22 20:00:15.624+00 | 3.0 |
| c0dcd666-4c74-4e90-a5ba-82632404e784 | fc862b39-28f6-4346-8a85-ad4fa240f568 | return_customer | Zullu | 2026-09-18 20:45:54.778+00 | 3.2 |
| ae7d13f1-cee5-4c3b-9fc7-27cc9694a41f | 15d5516f-6641-4076-9a22-251e40b95816 | customer_unresponsive | Betim | 2026-09-18 19:17:43.529+00 | 3.2 |
| 095f265b-669b-437e-81dc-6d0b2bb91b53 | 094a5e9a-973c-405a-8e4a-a6178c599daf | customer_unresponsive | Rodrigo | 2026-09-22 20:49:06.73+00 | 3.2 |
| 275ff85e-c350-4405-81e4-1dfab63cf1f2 | 418deded-edd4-4bcb-b8b7-5f60fc7287b8 | customer_unresponsive | Jerres Sousa | 2026-09-21 13:04:59.926+00 | 3.3 |
| b0d509b3-1792-4c3f-bd58-317960fb7b45 | fb9a856b-0ffe-406b-bcbc-6886f90c7a90 | return_customer | rose | 2026-09-18 20:22:27.736+00 | 3.4 |
| 5dcdad62-e6bb-4251-9e5b-f6285594c52e | c091d077-1815-4d33-9c09-d8012342f5a5 | return_customer | oliveira_antonioantonio | 2026-09-18 20:23:06.696+00 | 3.4 |
| 3ef1debc-06d9-4861-bb39-ac7e124b181c | c28b187f-8b74-4d86-b134-aef42549b3e1 | return_customer | Milson | 2026-09-22 20:13:58.971+00 | 3.4 |
| bf15cf35-fc56-4e34-9bb0-50f9cacf18ad | 529d026f-beaf-420d-b0a9-a2233efeb68c | customer_unresponsive | Maria José | 2026-09-18 20:49:27.778+00 | 3.5 |
| bdcf27d4-fcc1-4578-aed1-ee639bb9f971 | 40cb6716-03f9-49a0-a7af-53c40cc148fb | customer_unresponsive | Maria Madalena | 2026-09-22 18:21:18.543+00 | 3.6 |
| ef9583f1-74e2-472e-87c7-93feb22a4195 | f77c133d-b0ae-4a23-9b86-529bda8247fd | return_customer | Angelo | 2026-09-22 20:19:49.092+00 | 3.6 |
| 7ba9902a-374f-4cc6-b4c6-699dd12ec0fa | b47cdfdf-afa3-4a04-abe8-8ae8e5acbafa | return_customer | Chico moedas | 2026-09-12 13:30:20.663+00 | 3.6 |
| fc1a7fa8-30fa-4933-870f-0820dff25c1e | b47cdfdf-afa3-4a04-abe8-8ae8e5acbafa | customer_unresponsive | Chico moedas | 2026-09-12 13:30:20.663+00 | 3.6 |
| 82a062ef-2c55-4f31-b189-337a20482718 | 4c7ae370-1cc8-4560-9275-2a2cca4d839c | return_customer | 🙏🏻 Deus😍😍 | 2026-09-22 18:20:53.208+00 | 3.6 |
| 90e56fec-8799-4411-a7a6-52077e6c0b2f | 7071f7b6-6432-4fc9-bc4a-b867f86d24f8 | return_customer | Laudemir Fernandes | 2026-09-22 20:15:33.319+00 | 4.0 |
| 0ebbfb1b-f3c1-4334-a1fa-2b381f70bcf1 | 9f58e6f0-edff-40d6-bbab-d239618904b0 | customer_unresponsive | 👏🏽 | 2026-09-21 13:05:52.851+00 | 4.3 |
| 71dfb81d-b07c-402a-b2c9-ee34f8c6c643 | a1dae106-21bf-41f1-b7f9-b0cc7c604eef | customer_unresponsive | Débora Almeida💕 | 2026-09-15 14:32:23.669+00 | 4.6 |
| c615ac5d-f99c-4467-9d33-08af864fc296 | 0dc1b4f8-d828-4d7f-ada9-dd7e3f31a86d | customer_unresponsive | Nelcy | 2026-09-15 14:29:00.379+00 | 4.8 |
| 7c1e282f-7dc7-4470-8486-af9b81f544a5 | 28b81911-cea6-4daa-96f0-aa1f3ae3107d | customer_unresponsive | Wandim👮🏻‍♂️ | 2026-09-22 18:24:40.439+00 | 5.9 |
| 518cfd4b-1a54-4a24-af14-64f5c340c8b6 | aeef4d36-28f0-40d7-9299-816775653f66 | return_customer | 𝓚𝓪𝓾𝓪̃ 𝓖𝓾𝓼𝓽𝓪𝓿𝓸 | 2026-09-18 19:51:10.297+00 | 6.9 |
| 87182433-1458-4416-9cc2-b19d7258bbda | b81e0097-87c1-4eea-838f-024da9eaa0cb | vehicle_followup | 🥰🥰☺️ | 2026-09-11 19:01:21.298+00 | 7.2 |
| a7d3c6c9-46d6-4223-b83d-abb0107fac6a | 063bbb8f-8606-41b7-9416-f01ad078457a | consortium_followup | izabela | 2026-09-22 20:45:34.617+00 | 10.7 |
| d04969a4-ad73-44dd-ba31-24bf7c1cad28 | 6b8a2e88-f3eb-4326-a1d9-509d03433768 | customer_unresponsive | Ana Lucia Miranda Lopes S | 2026-09-10 15:57:56.001+00 | 13.2 |
| 84d6345f-0a69-4c67-b650-26443bc3a3b7 | 15617bbc-ea93-4d4c-9ba3-051049be5e26 | customer_unresponsive | C. Miranda | 2026-09-22 18:24:25.626+00 | 13.3 |
| 303f5cec-e274-43e9-9f43-02e5c4b76879 | 2bdb2cc2-b16f-46ad-adbb-8811889a8504 | customer_unresponsive | Brito | 2026-09-18 20:22:51.283+00 | 13.7 |
| 79591690-530f-43e5-8812-6b3f78b95e10 | a6ad2192-28ae-4c57-9e97-215546977d02 | customer_unresponsive | Natalia | 2026-09-15 14:29:27.36+00 | 17.5 |
| d11e005b-77f8-493d-a0fe-7bbfd556d747 | 9f2f5941-dc91-445b-9755-9a6e8dd31fd3 | return_customer | Valdinez | 2026-09-11 11:41:59.772+00 | 20.6 |
| 05fc6e19-6ec9-411e-a9f1-5b51e55b971d | c95b3991-c40d-4c95-8d00-01fdbb3d07fa | return_customer | sempre deus!!!! | 2026-09-22 20:28:04.361+00 | 20.8 |
| cf160c15-aab1-47cd-bb25-5d3803ca9b57 | 2d643894-ca44-4827-b70a-7c18982c66d1 | return_customer | Elizeth 🌶️ | 2026-09-15 14:39:17.034+00 | 21.7 |
| 2d05ab7c-2d2d-4459-8693-423cd7847081 | 8c8385ad-c523-48d6-a135-4db926eeb12d | customer_unresponsive | o senhor mau pastor ndmft | 2026-09-15 14:38:41.949+00 | 24.9 |
| 0c2779cb-752d-4fcf-ae45-ea64a50e7f38 | dd2d969d-0f3b-433a-b0f4-b70384dddd6e | consortium_followup | Elicelio Rodrigues Batist | 2026-09-18 19:50:48.676+00 | 28.4 |
| 72463558-4f0c-4a95-b30f-64c7550ad1b4 | 6c8a43dc-e93a-41ab-a361-1b7b904d7b16 | return_customer | Guilherme Rotilli | 2026-09-22 20:00:59.947+00 | 31.7 |
| 540e5888-68be-4e6d-b3da-c7faf742b404 | 75c313e9-e58e-4091-96a0-987fce94a356 | run_quote | . | 2026-08-27 19:03:34.17+00 | 41.6 |
| 05f07cef-a8ba-4656-89ab-0ca8300831b7 | 4abad23b-93a1-47df-b0d0-0516f637a8ee | financing_followup | Deus | 2026-09-22 20:15:05.343+00 | 44.4 |
| 15289eeb-36bd-4e76-a75a-c3871091aeb9 | 153dd68a-0c96-4a71-9ee2-e68cae2e286a | customer_unresponsive | Maria Bezerra | 2026-09-22 19:37:35.092+00 | 44.5 |
| b31813d6-2178-4caf-be72-1e0427c0e4f0 | c217463d-4e10-4d72-ab82-402cb2afb4b5 | return_customer | Sonia Passos | 2026-09-22 20:29:49.901+00 | 46.8 |
| f78671cb-a577-4fe3-bcb0-f5bc368456fc | 1b7f364c-1578-4b1a-ae83-a162ad6f91e9 | vehicle_followup | Luciene | 2026-09-15 19:07:18.27+00 | 89.1 |
| 39ef88e3-8f7d-4dc7-86f7-fa26c7ccd311 | 6649ab42-1111-4cf3-a872-1871d67077de | return_customer | Luciene | 2026-09-22 20:21:47.322+00 | 108.5 |