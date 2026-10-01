import { CareerSourceError } from './career-source';
import { safeSourceRedirect, type SourceRedirect } from './career-source-redirect';
export type SourceFailureCode='source_forbidden'|'source_rate_limited'|'source_challenge'|'source_redirect'|'source_http'|'source_timeout'|'source_network'|'source_decode_error'|'source_parser_error'|'source_size_limit'|'source_internal_error';
export function classifyCareerSourceError(error:unknown):{code:SourceFailureCode;stage:'source_response'|'source_decode'|'source_parse'|'source_end';status:number;httpStatus?:number;message:string;sourceRedirect?:SourceRedirect}{
  const known=error instanceof CareerSourceError, message=error instanceof Error?error.message:'';
  const httpStatus=known?error.httpStatus:undefined;
  const sourceRedirect=safeSourceRedirect(known?error.sourceRedirect:undefined);
  let code:SourceFailureCode='source_internal_error',stage:'source_response'|'source_decode'|'source_parse'|'source_end'='source_end',detail='来源处理发生内部脚本或存储异常';
  if(known){
    if(httpStatus===403){code='source_forbidden';stage='source_response';detail='学校服务器拒绝访问（HTTP 403），已停止，不尝试绕过';}
    else if(httpStatus===429){code='source_rate_limited';stage='source_response';detail='学校服务器限流（HTTP 429），已停止';}
    else if(/access challenge/.test(message)){code='source_challenge';stage='source_response';detail='学校网站返回安全验证页面，已停止，不尝试绕过';}
    else if(/redirect/.test(message)){
      code='source_redirect';stage='source_response';
      const reason=sourceRedirect?.kind==='login'?'登录页面':sourceRedirect?.kind==='challenge'?'安全验证页面':sourceRedirect?.kind==='external'?'外站':sourceRedirect?.kind==='same_origin_public'?'同源公开路径':sourceRedirect?.kind==='same_origin_other'?'同源其他路径':sourceRedirect?.kind==='insecure'?'非 HTTPS 地址':sourceRedirect?.kind==='invalid'?'异常地址':'未提供 Location';
      detail=`学校网站返回${httpStatus?` HTTP ${httpStatus}`:''} 重定向（${reason}），已停止，未跟随${sourceRedirect?`；安全目标：${sourceRedirect.target}`:''}`;
    }
    else if(/timed out/.test(message)){code='source_timeout';stage='source_response';detail='学校来源请求超时（15 秒），尚不能判断为服务器拦截';}
    else if(/network request failed/.test(message)){code='source_network';stage='source_response';detail='学校来源网络连接失败，尚不能判断为服务器拦截';}
    else if(httpStatus&&httpStatus!==200){code='source_http';stage='source_response';detail=`学校服务器返回 HTTP ${httpStatus}，已停止`;}
    else if(/size limit|exceeds|oversized|Too many/.test(message)){code='source_size_limit';stage='source_decode';detail='来源内容超过安全处理上限，未截断冒充完整内容';}
    else if(/compressed|base64|UTF-8|encoded|serialization|placeholder|source offset/.test(message)){code='source_decode_error';stage='source_decode';detail='已取得来源，但 HTML 编码/压缩格式与脚本适配不兼容';}
    else{code='source_parser_error';stage='source_parse';detail='已取得来源，但页面结构或文本格式与解析脚本不兼容';}
  }else if(message==='Unverified source URL/id'||message==='Expected bounded rendered plain text, not HTML'||message==='Empty source'){
    code='source_parser_error';stage='source_parse';detail='已取得来源，但来源文本/元数据未通过解析校验';
  }
  return {code,stage,status:code==='source_internal_error'?500:502,httpStatus,message:`${detail}；保护冷却 15 分钟。不是 AI 输出预算错误`,...(code==='source_redirect'&&sourceRedirect?{sourceRedirect}: {})};
}
