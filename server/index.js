import express from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import dns from 'node:dns'
import ExcelJS from 'exceljs'
import admin from 'firebase-admin'
import nodemailer from 'nodemailer'

dns.setDefaultResultOrder('ipv4first')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const seedDataDir = path.join(__dirname, '../data')
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : seedDataDir
const dataFile = path.join(dataDir, 'bookings.json')
const servicesFile = path.join(dataDir, 'services.json')
const settingsFile = path.join(dataDir, 'settings.json')
const importTaskFile = path.join(dataDir, 'import-task.json')
const pushTokensFile = path.join(dataDir, 'push-tokens.json')
const app = express()
const PORT = process.env.PORT || 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fhy'
const runningImportTasks = new Set()
let firebaseAppReady = false
let mailTransporter = null

app.use(express.json())

async function ensureDataDir() { await fs.mkdir(dataDir, { recursive: true }) }
function retainedBookings(bookings) {
  const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 1)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  return bookings.filter(booking => String(booking.date || '') >= cutoffDate)
}
async function readBookings() {
  try {
    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'))
    const retained = retainedBookings(Array.isArray(stored) ? stored : [])
    if (retained.length !== stored.length) await writeBookings(retained)
    return retained
  } catch (error) {
    if (error.code === 'ENOENT') { await ensureDataDir(); await fs.writeFile(dataFile, '[]'); return [] }
    throw error
  }
}

async function writeBookings(bookings) {
  await ensureDataDir()
  const temp = `${dataFile}.tmp`
  await fs.writeFile(temp, JSON.stringify(retainedBookings(bookings), null, 2))
  await fs.rename(temp, dataFile)
}
async function readServices() { try{return JSON.parse(await fs.readFile(servicesFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;await ensureDataDir();const defaults=JSON.parse(await fs.readFile(path.join(seedDataDir,'services.json'),'utf8'));await fs.writeFile(servicesFile,JSON.stringify(defaults,null,2));return defaults} }
async function writeServices(services) { await ensureDataDir();const temp=`${servicesFile}.tmp`; await fs.writeFile(temp, JSON.stringify(services,null,2)); await fs.rename(temp,servicesFile) }
async function readSettings() {
  const defaults = {
    announcement: '預約時間：早上 9:00 開始，晚上最晚預約時間 20:00。22:00 過後預約額外加 200 元。',
    googleSheetUrl: 'https://docs.google.com/spreadsheets/d/1T4lMv1PocK4PRN6JRp1vMyrTaEjou2F70TZgf_43IRM/edit?usp=drivesdk'
  }
  try { return { ...defaults, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) } } catch (error) {
    if (error.code === 'ENOENT') { await ensureDataDir();await fs.writeFile(settingsFile, JSON.stringify(defaults, null, 2)); return defaults }
    throw error
  }
}
async function writeSettings(settings) { await ensureDataDir();const temp=`${settingsFile}.tmp`; await fs.writeFile(temp,JSON.stringify(settings,null,2)); await fs.rename(temp,settingsFile) }
async function readImportTask() { try{return JSON.parse(await fs.readFile(importTaskFile,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw error} }
async function writeImportTask(task) { await ensureDataDir();const temp=`${importTaskFile}.tmp`; await fs.writeFile(temp,JSON.stringify(task,null,2)); await fs.rename(temp,importTaskFile) }
async function readPushTokens() { try{const value=JSON.parse(await fs.readFile(pushTokensFile,'utf8'));return Array.isArray(value)?value:[]}catch(error){if(error.code==='ENOENT')return [];throw error} }
async function writePushTokens(tokens) { await ensureDataDir();const temp=`${pushTokensFile}.tmp`;await fs.writeFile(temp,JSON.stringify(tokens,null,2));await fs.rename(temp,pushTokensFile) }
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
}
function getMailTransporter() {
  if (mailTransporter) return mailTransporter
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!user || !pass) return null
  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com'
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_CONNECT_HOST || smtpHost,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
    family: 4,
    lookup: (hostname, options, callback) => dns.lookup(hostname, { ...options, family: 4 }, callback),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: { servername: process.env.SMTP_TLS_SERVERNAME || smtpHost },
    auth: { user, pass }
  })
  return mailTransporter
}
function bookingEmailHtml(booking) {
  const lines = [
    ['預約日期', booking.date],
    ['預約時間', `${booking.startTime}–${booking.endTime}`],
    ['服務項目', (booking.services || []).join('、')],
    ['姓名', booking.name],
    ['備註', booking.note || '無']
  ]
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC','Microsoft JhengHei',Arial,sans-serif;line-height:1.8;color:#2f342d">
    <h2 style="margin:0 0 16px;color:#74836a">預約成功</h2>
    <p>妳的預約已成立，以下是預約資訊：</p>
    <table style="border-collapse:collapse;margin-top:12px">${lines.map(([label,value])=>`<tr><td style="padding:6px 18px 6px 0;color:#747b6f">${label}</td><td style="padding:6px 0;font-weight:600">${String(value).replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]))}</td></tr>`).join('')}</table>
    <p style="margin-top:18px;color:#747b6f">如需調整或取消預約，請回到預約頁面操作，或使用頁面底部的 LINE 聯絡。</p>
  </div>`
}
function bookingEmailPayload(booking) {
  return {
    to: booking.email || booking.phone,
    subject: `預約成功：${booking.date} ${booking.startTime}`,
    text: `預約成功\n日期：${booking.date}\n時間：${booking.startTime}–${booking.endTime}\n服務：${(booking.services||[]).join('、')}\n姓名：${booking.name}\n備註：${booking.note || '無'}`,
    html: bookingEmailHtml(booking),
    booking: {
      id: booking.id,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      services: booking.services || [],
      name: booking.name,
      note: booking.note || ''
    }
  }
}
async function sendBookingConfirmationViaEmailService(booking) {
  const baseUrl = String(process.env.EMAIL_SERVICE_URL || '').trim().replace(/\/+$/, '')
  if (!baseUrl) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.EMAIL_SERVICE_TIMEOUT_MS || 15000))
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (process.env.EMAIL_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.EMAIL_SERVICE_TOKEN}`
    const res = await fetch(`${baseUrl}/send-booking-email`, {
      method: 'POST',
      headers,
      body: JSON.stringify(bookingEmailPayload(booking)),
      signal: controller.signal
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.message || `Email service returned ${res.status}`)
    console.info('Email service sent', { bookingId: booking.id, to: String(booking.email || booking.phone).replace(/^(.{2}).*(@.*)$/, '$1***$2'), messageId: body.messageId })
    return true
  } finally {
    clearTimeout(timer)
  }
}
async function sendBookingConfirmation(booking) {
  const to = booking.email || booking.phone
  if (!validEmail(to)) return false
  if (process.env.EMAIL_SERVICE_URL) return sendBookingConfirmationViaEmailService(booking)
  const transporter = getMailTransporter()
  if (!transporter) return false
  const payload = bookingEmailPayload(booking)
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || `指尖日常 <${process.env.SMTP_USER}>`,
    to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html
  })
  console.info('Email sent', { bookingId: booking.id, to: String(to).replace(/^(.{2}).*(@.*)$/, '$1***$2'), messageId: info.messageId })
  return true
}
async function latestImportTask() {
  const task=await readImportTask()
  if(task?.status==='running'&&!runningImportTasks.has(task.id)){
    task.status='error';task.error='上一次同步因服務重啟而中斷，請重新開始同步。';task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    task.progress=[...(task.progress||[]),{id:crypto.randomUUID(),message:task.error,status:'error',time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}]
    await writeImportTask(task)
  }
  return task
}
function isAdmin(req) { return req.headers['x-admin-password'] === ADMIN_PASSWORD }
function initFirebaseApp() {
  if (firebaseAppReady) return true
  try {
    if (Array.isArray(admin.apps) && admin.apps.length) { firebaseAppReady = true; return true }
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    const rawBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    if (rawJson || rawBase64) {
      const serviceAccount = JSON.parse(rawJson || Buffer.from(rawBase64, 'base64').toString('utf8'))
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() })
    } else {
      return false
    }
    firebaseAppReady = true
    return true
  } catch (error) {
    console.error('Firebase init failed', error)
    return false
  }
}
async function notifyAdmins(title, body, data = {}) {
  if (!initFirebaseApp()) return
  const tokens = await readPushTokens()
  const fcmTokens = tokens.map(item => item.token).filter(Boolean)
  if (!fcmTokens.length) return
  const response = await admin.messaging().sendEachForMulticast({
    tokens: fcmTokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([key,value])=>[key,String(value ?? '')])),
    android: { priority: 'high', notification: { channelId: 'booking_changes' } }
  })
  if (response.failureCount) {
    const invalid = new Set()
    response.responses.forEach((item,index)=>{
      const code=item.error?.code || ''
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) invalid.add(fcmTokens[index])
    })
    if (invalid.size) await writePushTokens(tokens.filter(item => !invalid.has(item.token)))
  }
}

function minutesOf(value) { const [h, m] = value.split(':').map(Number); return h * 60 + m }
function minutesToClock(value) { return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}` }
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd }
function publicBooking(b) { return { id: b.id, date: b.date, startTime: b.startTime, endTime: b.endTime, services: b.services, displayName: `${b.name.trim().slice(0, 1)}小姐` } }
function ownerBooking(b) { return { ...publicBooking(b), name: b.name, email: b.email || b.phone || '', phone: b.phone, note: b.note, serviceIds: b.serviceIds || [] } }
function scheduleBooking(b) { return { id:b.id,date:b.date,startTime:b.startTime,endTime:b.endTime } }
function sheetCsvUrl(value) { const match=String(value||'').match(/spreadsheets\/d\/([\w-]+)/); return match ? `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv` : null }
function normalizeAiRecord(record) {
  const type=record.type==='leave'?'leave':'booking', date=String(record.date||''), startTime=String(record.startTime||''), endTime=String(record.endTime||'')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(startTime)||!/^\d{2}:\d{2}$/.test(endTime)||minutesOf(startTime)>=minutesOf(endTime))return null
  return {type,date,startTime,endTime,services:type==='leave'?['休假']:(Array.isArray(record.services)?record.services.map(String):['Google 匯入']),name:type==='leave'?'休假':String(record.name||'Google 匯入'),phone:'',note:String(record.note||record.raw||''),source:'google-sheet'}
}
function parseJsonContent(content) {
  const text = String(content || '').trim()
  if (!text) throw new Error('DeepSeek 回傳空白內容')
  try { return JSON.parse(text) } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('DeepSeek 回傳內容不是有效 JSON')
  }
}
async function askDeepSeek(prompt){
  let lastError
  for(let attempt=0;attempt<4;attempt++)try{
    const useJsonMode=attempt<3
    const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}`},body:JSON.stringify({model:'deepseek-chat',messages:[{role:'system',content:'你只輸出有效 JSON，不輸出說明文字。'},{role:'user',content:prompt}],...(useJsonMode?{response_format:{type:'json_object'}}:{}),temperature:0,max_tokens:8000})})
    const raw=await response.text()
    let body
    try{body=raw?JSON.parse(raw):{}}catch{throw new Error(`DeepSeek API 回傳格式異常：${raw.slice(0,120)}`)}
    if(!response.ok)throw new Error(body.error?.message||`DeepSeek API 錯誤（HTTP ${response.status}）`)
    return parseJsonContent(body.choices?.[0]?.message?.content)
  }catch(error){
    lastError=error
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve, 600*(attempt+1)))
  }
  throw lastError
}
function chunkLabel(chunk) {
  const dates=chunk.map(line=>line.split(',')[0]?.trim()).filter(Boolean)
  if(!dates.length)return '這批'
  return dates.length===1?dates[0]:`${dates[0]}–${dates[dates.length-1]}`
}
async function recognizeGoogleImportRows({instructions,dateLines,onProgress}) {
  await onProgress('正在請 DeepSeek 辨識整份預約表…')
  try {
    const parsed=await askDeepSeek(`${instructions}\nCSV：\n${dateLines.join('\n')}`)
    const count=Array.isArray(parsed.records)?parsed.records.length:0
    await onProgress(`整份預約表辨識完成，識別 ${count} 筆。`)
    return [parsed]
  } catch (error) {
    await onProgress(`整份辨識失敗，改用較小範圍重試：${error.message}`)
  }
  const chunks=[];for(let i=0;i<dateLines.length;i+=2)chunks.push(dateLines.slice(i,i+2))
  const parsedChunks=[]
  for(let index=0;index<chunks.length;index++){
    const label=chunkLabel(chunks[index])
    await onProgress(`正在辨識 ${label} 的預約資料…`)
    const parsed=await askDeepSeek(`${instructions}\nCSV：\n${chunks[index].join('\n')}`)
    parsedChunks.push(parsed)
    const count=Array.isArray(parsed.records)?parsed.records.length:0
    await onProgress(`${label} 完成，識別 ${count} 筆。`)
  }
  return parsedChunks
}

async function buildGoogleImportRecords({url:rawUrl,year:rawYear,onProgress=()=>{}}){
  const settings=await readSettings(), url=sheetCsvUrl(rawUrl||settings.googleSheetUrl), year=Number(rawYear)||new Date().getFullYear()
  if(!url)throw new Error('Google 表格連結格式不正確。')
  await onProgress('正在讀取 Google 預約表…')
  const sheetResponse=await fetch(url);if(!sheetResponse.ok)throw new Error('無法讀取 Google 表格，請確認連結可公開檢視。')
  const csv=await sheetResponse.text(), services=await readServices(), dateLines=csv.split(/\r?\n/).filter(line=>/^\d{1,2}\/\d{1,2},/.test(line.trim()))
  await onProgress(`已讀取表格，找到 ${dateLines.length} 行日期資料。`)
  const instructions=`你是台灣美甲預約資料整理助手。把 CSV 轉成 json，年份是 ${year}。只輸出 {"records":[]} JSON。每個有時間的預約是一筆 booking，日期為 YYYY-MM-DD，時間為 HH:mm。services 只能是：${services.map(s=>s.name).join('、')}。手=手部美甲，足=足部美甲，卸=卸甲。endTime 按服務時間加總：${services.map(s=>`${s.name}${s.minutes}分鐘`).join('、')}；項目不明預設 120 分鐘。「休假」「有事」「勿約」轉 leave；沒時間為 09:00–22:00，早上為 09:00–13:00，某時間後到 22:00，明確範圍照原文。name 只填明確人名，否則「Google 匯入」。note 保留原始格文字。不要產生標題或公告。範例：{"records":[{"type":"booking","date":"${year}-07-01","startTime":"10:30","endTime":"13:30","services":["卸甲","手部美甲"],"name":"Google 匯入","note":"10：30卸+手"},{"type":"leave","date":"${year}-07-17","startTime":"09:00","endTime":"22:00","services":[],"name":"休假","note":"休假"}]}`
  const parsedChunks=await recognizeGoogleImportRows({instructions,dateLines,onProgress})
  await onProgress('正在檢查重複與時段衝突…')
  const normalized=parsedChunks.flatMap(parsed=>Array.isArray(parsed.records)?parsed.records:[]).map(normalizeAiRecord).filter(Boolean), bookings=await readBookings()
  const statusOrder={conflict:0,duplicate:1,ready:2}
  return normalized.map((record,index)=>{const signature=`${record.date}|${record.startTime}|${record.endTime}|${record.type}|${record.note}`;const duplicate=bookings.some(b=>b.importSignature===signature);const conflict=!duplicate&&bookings.some(b=>b.date===record.date&&overlaps(minutesOf(record.startTime),minutesOf(record.endTime),minutesOf(b.startTime),minutesOf(b.endTime)));return {...record,tempId:`import-${index}`,status:duplicate?'duplicate':conflict?'conflict':'ready'}}).sort((a,b)=>statusOrder[a.status]-statusOrder[b.status]||`${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
}

async function runImportTask(task){
  runningImportTasks.add(task.id)
  const progress=async(message,status='working')=>{
    task.progress.push({id:crypto.randomUUID(),message,status,time:new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',second:'2-digit'})})
    task.updatedAt=new Date().toISOString()
    await writeImportTask(task)
  }
  try{
    await progress('準備開始匯入…')
    const records=await buildGoogleImportRecords({...task.params,onProgress:progress})
    task.status='done';task.records=records;task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    await progress(`辨識完成，共 ${records.length} 筆。`,'done')
  }catch(error){
    task.status='error';task.error=`DeepSeek 匯入失敗：${error.message}`;task.updatedAt=new Date().toISOString();task.finishedAt=task.updatedAt
    await progress(task.error,'error')
  }finally{
    runningImportTasks.delete(task.id)
  }
}

app.get('/api/services', async (_req,res)=>res.json(await readServices()))
app.get('/api/health', (_req,res)=>res.json({ok:true}))
app.get('/api/settings', async (_req,res)=>res.json(await readSettings()))
app.get('/api/bookings', async (_req, res) => res.json((await readBookings()).map(b=>({...scheduleBooking(b),type:b.type||'booking'}))))
app.get('/api/my-bookings', async (req,res)=>{ const token=req.headers['x-owner-token']; if(!token)return res.json([]);const serviceList=await readServices();res.json((await readBookings()).filter(b=>b.ownerToken===token).map(b=>({...ownerBooking(b),serviceIds:b.serviceIds||b.services.map(name=>serviceList.find(s=>s.name===name)?.id).filter(Boolean)}))) })

app.post('/api/bookings', async (req, res) => {
  const { date, startTime, selectedServices, name, note = '', ownerToken } = req.body
  const email = String(req.body.email || req.body.phone || '').trim()
  const serviceList=await readServices(); const serviceMap=Object.fromEntries(serviceList.map(s=>[s.id,s]))
  if (!date || !startTime || !name?.trim() || !validEmail(email) || !ownerToken || !Array.isArray(selectedServices) || !selectedServices.length || selectedServices.some(id => !serviceMap[id])) return res.status(400).json({ message: '請填寫正確的預約資料。' })
  const duration = selectedServices.reduce((sum, id) => sum + serviceMap[id].minutes, 0)
  const start = minutesOf(startTime), end = start + duration
  if (start < 540 || start > 1200 || end > 1320 || start % 30) return res.status(400).json({ message: '可預約開始時間為 09:00–20:00，且服務需在 22:00 前完成。' })
  const bookings = await readBookings()
  if (bookings.some(b => b.date === date && overlaps(start, end, minutesOf(b.startTime), minutesOf(b.endTime)))) return res.status(409).json({ message: '這個時段剛剛已被預約，請選擇其他時間。' })
  const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
  const booking = { id: crypto.randomUUID(), date, startTime, endTime, services: selectedServices.map(id => serviceMap[id].name), serviceIds:selectedServices, name: name.trim(), email, phone: email, note: note.trim(), ownerToken, createdAt: new Date().toISOString() }
  bookings.push(booking); await writeBookings(bookings)
  notifyAdmins('有新的客人預約', `${booking.date} ${booking.startTime}–${booking.endTime} ${booking.name} ${booking.services.join('、')}`, {event:'booking_created', bookingId:booking.id}).catch(error=>console.error('Push notification failed',error))
  sendBookingConfirmation(booking).catch(error=>console.error('Email send failed',error))
  res.status(201).json(ownerBooking(booking))
})

app.delete('/api/my-bookings/:id',async(req,res)=>{ const token=req.headers['x-owner-token']; const bookings=await readBookings(); const index=bookings.findIndex(b=>b.id===req.params.id&&b.ownerToken===token); if(index<0)return res.status(403).json({message:'無法取消這筆預約。'}); const [removed]=bookings.splice(index,1); await writeBookings(bookings); notifyAdmins('有客人取消預約', `${removed.date} ${removed.startTime}–${removed.endTime} ${removed.name || ''}`, {event:'booking_cancelled', bookingId:removed.id}).catch(error=>console.error('Push notification failed',error)); res.status(204).end() })
app.put('/api/my-bookings/:id',async(req,res)=>{const token=req.headers['x-owner-token'];const bookings=await readBookings();const index=bookings.findIndex(b=>b.id===req.params.id&&b.ownerToken===token);if(index<0)return res.status(403).json({message:'無法修改這筆預約。'});const{date,startTime,selectedServices,name,note=''}=req.body;const email=String(req.body.email||req.body.phone||'').trim();const serviceList=await readServices();const serviceMap=Object.fromEntries(serviceList.map(s=>[s.id,s]));if(!date||!startTime||!name?.trim()||!validEmail(email)||!selectedServices?.length||selectedServices.some(id=>!serviceMap[id]))return res.status(400).json({message:'請填寫正確的預約資料。'});const duration=selectedServices.reduce((sum,id)=>sum+serviceMap[id].minutes,0),start=minutesOf(startTime),end=start+duration;if(start<540||start>1200||end>1320)return res.status(400).json({message:'超出可預約時間。'});if(bookings.some((b,i)=>i!==index&&b.date===date&&overlaps(start,end,minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這個時段已有其他預約或休假。'});const updated={...bookings[index],date,startTime,endTime:minutesToClock(end),services:selectedServices.map(id=>serviceMap[id].name),serviceIds:selectedServices,name:name.trim(),email,phone:email,note:note.trim(),updatedAt:new Date().toISOString()};bookings[index]=updated;await writeBookings(bookings);res.json(ownerBooking(updated))})
app.post('/api/admin/login',(req,res)=>req.body.password===ADMIN_PASSWORD?res.json({ok:true}):res.status(401).json({message:'密碼不正確。'}))
app.post('/api/admin/test-email',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  const email=String(req.body.email||'').trim()
  if(!validEmail(email))return res.status(400).json({message:'請填寫正確的測試信箱。'})
  try{
    await sendBookingConfirmation({id:`test-${Date.now()}`,date:new Date().toISOString().slice(0,10),startTime:'09:00',endTime:'09:30',services:['郵件測試'],name:'郵件測試',email,note:'這是一封測試信。'})
    res.json({ok:true,message:'測試郵件已送出。'})
  }catch(error){
    console.error('Test email failed', error)
    res.status(502).json({message:error.message||'測試郵件發送失敗。'})
  }
})
app.post('/api/admin/push-token',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  const token=String(req.body.token||'').trim()
  if(!token)return res.status(400).json({message:'缺少推送 token。'})
  const tokens=await readPushTokens(),now=new Date().toISOString()
  const existing=tokens.find(item=>item.token===token)
  if(existing){existing.updatedAt=now;existing.platform=String(req.body.platform||existing.platform||'android')}
  else tokens.push({token,platform:String(req.body.platform||'android'),createdAt:now,updatedAt:now})
  await writePushTokens(tokens)
  res.json({ok:true,enabled:initFirebaseApp(),count:tokens.length})
})
app.get('/api/admin/bookings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});res.json(await readBookings())})
app.post('/api/admin/bookings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const{date,startTime,serviceId,name,phone='',note=''}=req.body;const email=String(req.body.email||phone||'').trim();const serviceList=await readServices();const service=serviceList.find(s=>s.id===serviceId);if(!date||!startTime||!service||!name?.trim())return res.status(400).json({message:'請完整填寫預約資料。'});const start=minutesOf(startTime),end=start+service.minutes;if(start<540||start>1200||end>1320)return res.status(400).json({message:'超出可預約時間。'});const bookings=await readBookings();if(bookings.some(b=>b.date===date&&overlaps(start,end,minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這個時段已有預約或休假。'});const booking={id:crypto.randomUUID(),type:'booking',date,startTime,endTime:minutesToClock(end),services:[service.name],serviceIds:[service.id],name:name.trim(),email,phone:email||String(phone).trim(),note:note.trim(),ownerToken:'admin',createdAt:new Date().toISOString()};bookings.push(booking);await writeBookings(bookings);if(validEmail(email))sendBookingConfirmation(booking).catch(error=>console.error('Email send failed',error));res.status(201).json(booking)})
app.post('/api/admin/leaves',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const{date,startTime='09:00',endTime='22:00',note=''}=req.body;if(!date||minutesOf(startTime)>=minutesOf(endTime))return res.status(400).json({message:'休假時間不正確。'});const bookings=await readBookings();if(bookings.some(b=>b.date===date&&overlaps(minutesOf(startTime),minutesOf(endTime),minutesOf(b.startTime),minutesOf(b.endTime))))return res.status(409).json({message:'這段時間已有預約或休假，請先處理原有資料。'});const leave={id:crypto.randomUUID(),type:'leave',date,startTime,endTime,services:['休假'],name:'休假',phone:'',note:note.trim(),ownerToken:'admin',createdAt:new Date().toISOString()};bookings.push(leave);await writeBookings(bookings);res.status(201).json(leave)})
app.put('/api/admin/services',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const list=req.body;if(!Array.isArray(list)||list.some(s=>!s.id||!s.name||!Number.isFinite(+s.minutes)||+s.minutes<30||!Number.isFinite(+s.price)||+s.price<0))return res.status(400).json({message:'項目資料不完整。'});await writeServices(list.map(s=>({...s,minutes:+s.minutes,price:+s.price,showPrice:s.showPrice!==false})));res.json(await readServices())})
app.put('/api/admin/settings',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const current=await readSettings();const next={...current,announcement:String(req.body.announcement||'').trim(),googleSheetUrl:String(req.body.googleSheetUrl||'').trim()};await writeSettings(next);res.json(next)})
app.get('/api/admin/import-google/latest',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  res.json(await latestImportTask())
})
app.post('/api/admin/import-google',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  if(!process.env.DEEPSEEK_API_KEY)return res.status(500).json({message:'伺服器尚未設定 DeepSeek API Key。'})
  const latest=await latestImportTask()
  if(latest?.status==='running')return res.status(409).json({message:'已有同步正在執行中。',task:latest})
  const task={id:crypto.randomUUID(),status:'running',params:{url:req.body.url||'',year:Number(req.body.year)||new Date().getFullYear()},progress:[],records:[],error:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:''}
  await writeImportTask(task)
  runImportTask(task).catch(error=>console.error('Google import task failed',error))
  res.status(202).json(task)
})
app.post('/api/admin/confirm-import',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const incoming=Array.isArray(req.body.records)?req.body.records:[],bookings=await readBookings();let imported=0,skipped=0;for(const raw of incoming){const record=normalizeAiRecord(raw);if(!record){skipped++;continue}const signature=`${record.date}|${record.startTime}|${record.endTime}|${record.type}|${record.note}`;if(bookings.some(b=>b.importSignature===signature||(b.date===record.date&&overlaps(minutesOf(record.startTime),minutesOf(record.endTime),minutesOf(b.startTime),minutesOf(b.endTime))))){skipped++;continue}bookings.push({...record,id:crypto.randomUUID(),importSignature:signature,ownerToken:'google-import',createdAt:new Date().toISOString()});imported++}await writeBookings(bookings);res.json({imported,skipped})})
app.get('/api/admin/export-excel',async(req,res)=>{
  if(!isAdmin(req))return res.status(401).json({message:'未授權'})
  const bookings=(await readBookings()).sort((a,b)=>`${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))
  const workbook=new ExcelJS.Workbook()
  workbook.creator='指尖日常預約系統';workbook.created=new Date()
  const sheet=workbook.addWorksheet('預約資料',{views:[{state:'frozen',ySplit:1}]})
  sheet.columns=[
    {header:'日期',key:'date',width:14},{header:'開始時間',key:'startTime',width:12},{header:'結束時間',key:'endTime',width:12},
    {header:'類型',key:'type',width:10},{header:'服務項目',key:'services',width:28},{header:'顧客姓名',key:'name',width:16},
    {header:'聯絡信箱',key:'email',width:26},{header:'備註',key:'note',width:34},{header:'資料來源',key:'source',width:16},{header:'建立時間',key:'createdAt',width:22}
  ]
  bookings.forEach(item=>sheet.addRow({date:item.date,startTime:item.startTime,endTime:item.endTime,type:item.type==='leave'?'休假':'預約',services:(item.services||[]).join('、'),name:item.type==='leave'?'':(item.name||''),email:item.type==='leave'?'':(item.email||item.phone||''),note:item.note||'',source:item.source==='google-sheet'?'Google 預約表':'網站預約',createdAt:item.createdAt?new Date(item.createdAt):''}))
  const header=sheet.getRow(1);header.height=26;header.font={bold:true,color:{argb:'FFFFFFFF'}};header.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF74836A'}};header.alignment={vertical:'middle'}
  sheet.autoFilter={from:'A1',to:'J1'}
  sheet.getColumn('date').numFmt='yyyy-mm-dd';sheet.getColumn('createdAt').numFmt='yyyy-mm-dd hh:mm'
  sheet.eachRow((row,index)=>{if(index>1){row.alignment={vertical:'top',wrapText:true};if(index%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF4F7F1'}}}})
  const buffer=await workbook.xlsx.writeBuffer(),stamp=new Date().toISOString().slice(0,10)
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(`預約資料-${stamp}.xlsx`)}`)
  res.send(Buffer.from(buffer))
})
app.delete('/api/admin/bookings/:id',async(req,res)=>{if(!isAdmin(req))return res.status(401).json({message:'未授權'});const bookings=await readBookings();const next=bookings.filter(b=>b.id!==req.params.id);if(next.length===bookings.length)return res.status(404).json({message:'找不到預約'});await writeBookings(next);res.status(204).end()})

app.use(express.static(path.join(__dirname, '../dist')))
app.use((_req, res) => res.sendFile(path.join(__dirname, '../dist/index.html')))
app.listen(PORT, () => console.log(`API running at http://localhost:${PORT}`))
