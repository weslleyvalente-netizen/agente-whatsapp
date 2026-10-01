import {beforeEach,describe,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({transcribeAudioMessage:vi.fn(),getInstanceById:vi.fn(),updateMessageContent:vi.fn()}));
vi.mock("@aula-agente/agent-runtime",()=>({transcribeAudioMessage:m.transcribeAudioMessage}));
vi.mock("@aula-agente/database",()=>({getInstanceById:m.getInstanceById,updateMessageContent:m.updateMessageContent}));
import {prepareFollowupAudioContext} from "./followup-audio-context.service.js";
const audio={id:"m",role:"human_agent",content:"[audio]",media_type:"audio",evolution_message_id:"wa",metadata:null};
beforeEach(()=>{vi.clearAllMocks();m.getInstanceById.mockResolvedValue({instance_name:"instance",organization_id:"org"});m.transcribeAudioMessage.mockResolvedValue({ok:true,text:"O banco não aprovou. Conseguiu outro CPF?"});});
describe("human audio context",()=>{
 it("transcribes the attendant audio before suggesting and stores the text once",async()=>{const result=await prepareFollowupAudioContext({} as any,{organization_id:"org",evolution_instance_id:"i"} as any,[audio] as any);expect(result.messages[0].content).toContain("outro CPF");expect(result.changed).toBe(true);expect(m.updateMessageContent).toHaveBeenCalledWith(expect.anything(),"m",expect.stringContaining("outro CPF"),expect.objectContaining({audio_transcribed_at:expect.any(String)}));});
 it("does not charge again for a saved transcription",async()=>{await prepareFollowupAudioContext({} as any,{organization_id:"org"} as any,[{...audio,content:"🎤 Conseguiu outro CPF?"}] as any);expect(m.transcribeAudioMessage).not.toHaveBeenCalled();});
 it("blocks suggestions when the missing audio cannot be recovered",async()=>{m.transcribeAudioMessage.mockResolvedValue({ok:false,reason:"media expired"});await expect(prepareFollowupAudioContext({} as any,{organization_id:"org",evolution_instance_id:"i"} as any,[audio] as any)).rejects.toThrow("áudio");expect(m.updateMessageContent).not.toHaveBeenCalled();});
 it("does not read media from an instance of another organization",async()=>{m.getInstanceById.mockResolvedValue({organization_id:"other"});await expect(prepareFollowupAudioContext({} as any,{organization_id:"org",evolution_instance_id:"i"} as any,[audio] as any)).rejects.toThrow();expect(m.transcribeAudioMessage).not.toHaveBeenCalled();});
});
