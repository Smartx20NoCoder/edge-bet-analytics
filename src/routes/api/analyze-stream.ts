import { createFileRoute } from "@tanstack/react-router";
import { handleAnalyzeStream } from "@/lib/analyze-stream.server";
export const Route = createFileRoute("/api/analyze-stream")({
  server: { handlers: {
    GET: async ({ request }) => handleAnalyzeStream(request),
    POST: async ({ request }) => {
      let batch;
      try {
        batch=await request.json();
        if(!Array.isArray(batch.processedIds)||batch.processedIds.length>10000||batch.processedIds.some((id:unknown)=>typeof id!=='string'||!/^goaloo:\d+$/.test(id))||!Number.isInteger(batch.remaining)||batch.remaining<0||batch.remaining>500)throw new Error('Invalid scan cursor.');
        if(batch.retryCounts&&(typeof batch.retryCounts!=='object'||Array.isArray(batch.retryCounts)||Object.entries(batch.retryCounts).some(([id,count])=>!/^goaloo:\d+$/.test(id)||!Number.isInteger(count)||Number(count)<0||Number(count)>2)))throw new Error('Invalid retry cursor.');
        if(batch.phase!==undefined&&!['goaloo','odds'].includes(batch.phase))throw new Error('Invalid scan phase.');
      }catch{return Response.json({error:'Invalid scan cursor.'},{status:400});}
      return handleAnalyzeStream(request,batch);
    },
  } },
});
