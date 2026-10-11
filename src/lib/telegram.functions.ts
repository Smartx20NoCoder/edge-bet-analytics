import {archiveStatus,startTelegramArchive} from './telegram-archive.server';
import {createServerFn} from '@tanstack/react-start';
import {z} from 'zod';
import {requireAdmin} from './admin-auth.server';
import {discoverTelegramChannels} from './telegram-api.server';
import {edgeTelegramStatus,saveEdgeTelegramSettings,publishEdgeSingles,publishEdgeSingleArchive,syncEdgeTelegramResults} from './telegram.server';
export const getEdgeTelegramStatus=createServerFn({method:'POST'})
 .inputValidator((value:unknown)=>z.object({accessToken:z.string().min(20)}).parse(value))
 .handler(async({data})=>{await requireAdmin(data.accessToken);const status=await edgeTelegramStatus();return {...status,archive:await archiveStatus(status.chat_id)};});
export const edgeTelegramAction=createServerFn({method:'POST'})
 .inputValidator((value:unknown)=>z.object({accessToken:z.string().min(20),action:z.enum(['discover','enable','disable','publish','results','archive']),chatId:z.string().max(30).optional(),restart:z.boolean().optional(),after:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(value))
 .handler(async({data})=>{
  await requireAdmin(data.accessToken);
  if(data.action==='discover')return {channels:await discoverTelegramChannels()};
  if(data.action==='enable'||data.action==='disable')return saveEdgeTelegramSettings(data.action==='enable',data.chatId);
  if(data.action==='archive')return startTelegramArchive(data.restart);
  if(data.action==='results')await syncEdgeTelegramResults();
  if(data.action==='publish')await publishEdgeSingles();
  return edgeTelegramStatus();
 });
