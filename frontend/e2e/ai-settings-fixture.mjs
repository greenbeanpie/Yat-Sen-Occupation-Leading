export const aiSettingsFixture = () => ({
  version:0,credentialStatus:'environment',updatedAt:null,encryptionAvailable:true,allowedHosts:['api.openai.com','opencode.ai'],
  config:{mode:'environment',providerPreset:'custom',protocol:'auto',baseUrl:'',model:'',reasoningEffort:'default',thinkingBudget:null,temperature:null,topP:null,maxOutputTokens:4096,timeoutMs:60000,maxAttempts:3,requestHeaders:{},goUserAgent:'YatSenOccupationLeading/1.0'},
  presets:[
    {id:'custom',label:'自定义 OpenAI 兼容 API',baseUrl:'',models:[]},
    {id:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1',models:[{id:'gpt-5',protocol:'responses',temperature:false,topP:false,samplingWithNoneOnly:false,reasoningEfforts:['minimal','low','medium','high']}]},
    {id:'opencode-go',label:'OpenCode Go（请先核对套餐用途）',baseUrl:'https://opencode.ai/zen/go/v1',models:[{id:'glm-5.3',protocol:'chat-completions',temperature:false,topP:false,samplingWithNoneOnly:false,reasoningEfforts:[]}]},
  ],
});
