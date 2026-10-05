/*
 * ADIAOO desktop runtime
 * - The server is the shared source of truth.
 * - localStorage is only a cache for offline startup.
 * - Each page always has 20 fixed slots. A null slot is an intentional empty position.
 */

const API_URL = window.ADIAOO_API_URL || '/api/desktop';
const CLIENT_KEY = 'adiaoo_desktop_client_id_v1';
const SLOTS_PER_PAGE = 20;
const GRID_PADDING = 20;
// Desktop columns are calculated from the actual viewport width.  Keeping a
// hard ten-column cap made the right side of wide screens unreachable while
// dragging.  The saved slot model can create another page when a user places
// an item beyond the current page's 20-slot block.
const RANKING_THRESHOLD = 3; // Change this value to control when an icon enters the ranking.
const LONG_PRESS_MS = 420;
const MOVE_CANCEL_DISTANCE = 12;
const DRAG_START_DISTANCE = 12;
const GOOGLE_FAVICON_BASE = 'https://www.google.com/s2/favicons?domain=';

// Known services use their own mark as a badge; other sites use their favicon.
const PLATFORM_RULES = [
  {key:'telegram', hosts:['t.me','telegram.me','telegram.org','web.telegram.org'], logo:'https://cdn.simpleicons.org/telegram'},
  {key:'discord', hosts:['discord.com','discordapp.com','discord.gg'], logo:'https://cdn.simpleicons.org/discord'},
  {key:'line', hosts:['line.me'], logo:'https://cdn.simpleicons.org/line'},
  {key:'whatsapp', hosts:['whatsapp.com','wa.me'], logo:'https://cdn.simpleicons.org/whatsapp'},
  {key:'matrix', hosts:['matrix.to','matrix.org'], logo:'https://cdn.simpleicons.org/matrix'},
  {key:'element', hosts:['element.io','app.element.io'], logo:'https://cdn.simpleicons.org/element'},
  {key:'signal', hosts:['signal.org','signal.me'], logo:'https://cdn.simpleicons.org/signal'},
  {key:'reddit', hosts:['reddit.com','redd.it','old.reddit.com','new.reddit.com'], logo:'https://cdn.simpleicons.org/reddit'}
];

const $ = selector => document.querySelector(selector);
const desktop = $('#desktop');
const pagesTrack = $('#pagesTrack');
const pageDots = $('#pageDots');
const dragLayer = $('#dragLayer');
const iconDialog = $('#iconDialog');
const trashDialog = $('#trashDialog');
const helpDialog = $('#helpDialog');
const rankingDialog = $('#rankingDialog');
const favoritesDialog = $('#favoritesDialog');
const trashButton = $('#trashButton');
const iconActionsMenu = $('#iconActionsMenu');

let state = createInitialState();
let currentPage = 0;
let selectedId = null;
let editMode = false;
let dragSession = null;
let pageSwipe = null;
let edgeTimer = null;
let edgeDirection = 0;
let actionMenuId = null;
let saveChain = Promise.resolve();
let serverAvailable = true;
let viewMode = 'desktop';
let likeMode = false;
let favoriteMode = false;
let rankingTab = 'likes';
let userListTab = 'likes';
const FAVORITES_KEY = 'adiaoo_user_favorites_v1';
const LIKED_ITEMS_KEY = 'adiaoo_user_likes_v1';
const RANKING_SNAPSHOTS_KEY = 'adiaoo_ranking_snapshots_v1';

function readLocalJson(key,fallback){try{const value=JSON.parse(localStorage.getItem(key)||'');return value??fallback}catch(error){return fallback}}
function writeLocalJson(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(error){toast('浏览器本地存储不可用')}}
function iconSnapshot(item){return {id:item.id,name:item.name,url:item.url,image:item.image||'',platform:item.platform||'',autoLogo:item.autoLogo||'',savedAt:Date.now(),likeCount:Number(item.likeCount)||0,favoriteCount:Number(item.favoriteCount)||0}}
function localFavorites(){return readLocalJson(FAVORITES_KEY,[]).filter(item=>item&&item.id&&item.url)}
function localRanking(){return readLocalJson(RANKING_SNAPSHOTS_KEY,{likes:[],favorites:[]})}
function localLikes(){let rows=readLocalJson(LIKED_ITEMS_KEY,null);if(!Array.isArray(rows)){rows=localRanking().likes||[];writeLocalJson(LIKED_ITEMS_KEY,rows)}return rows.filter(item=>item&&item.id&&item.url)}
async function saveFavorite(item){const previous=localFavorites();const list=previous.filter(entry=>entry.id!==item.id);const snapshot=iconSnapshot(item);list.unshift(snapshot);writeLocalJson(FAVORITES_KEY,list);try{const response=await requestServer('POST',{iconId:item.id,clientId},`${API_URL.replace(/\/$/,'')}/favorite`);snapshot.favoriteCount=Number(response.favoriteCount)||0;writeLocalJson(FAVORITES_KEY,list);writeRankingSnapshot('favorites',item,{favoriteCount:snapshot.favoriteCount});state.pages.forEach(page=>page.slots.forEach(icon=>{if(icon?.id===item.id)icon.favoriteCount=snapshot.favoriteCount}));return response}catch(error){writeLocalJson(FAVORITES_KEY,previous);throw error}}
function removeFavorite(id){writeLocalJson(FAVORITES_KEY,localFavorites().filter(item=>item.id!==id));renderUserLists()}
function isFavorite(id){return localFavorites().some(item=>item.id===id)}
function writeRankingSnapshot(type,item,counts={}){const data=localRanking();const list=Array.isArray(data[type])?data[type]:[];const existing=list.find(entry=>entry.id===item.id);const snapshot={...(existing||{}),...iconSnapshot(item),likedByCurrentClient:counts.likedByCurrentClient??existing?.likedByCurrentClient??Boolean(item.likedByCurrentClient),likeCount:counts.likeCount??existing?.likeCount??(Number(item.likeCount)||0),favoriteCount:counts.favoriteCount??existing?.favoriteCount??(Number(item.favoriteCount)||0)};if(existing)Object.assign(existing,snapshot);else list.push(snapshot);data[type]=list;writeLocalJson(RANKING_SNAPSHOTS_KEY,data)}

function createId(){
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getClientId(){
  try{
    let id = localStorage.getItem(CLIENT_KEY);
    if(!id){id=createId();localStorage.setItem(CLIENT_KEY,id)}
    return id;
  }catch(error){return 'anonymous'}
}

const clientId = getClientId();

// 设备模式只决定打开方式；页面、图标和回收站始终使用同一份共享数据。
function detectDeviceMode(){
  const forced=new URLSearchParams(location.search).get('mode');
  if(forced==='desktop'||forced==='mobile')return forced;
  return navigator.maxTouchPoints>0||matchMedia('(pointer:coarse)').matches?'mobile':'desktop';
}
const DEVICE_MODE=detectDeviceMode();
function interactionMode(event){
  if(event?.pointerType==='mouse')return 'desktop';
  if(event?.pointerType==='touch'||event?.pointerType==='pen')return 'mobile';
  return DEVICE_MODE;
}

function createPage(){return {slots:Array(SLOTS_PER_PAGE).fill(null)}}
function createInitialState(){return {version:4,revision:0,updatedAt:0,pages:[createPage()],trash:[]}}

function copyIcon(raw){
  if(!raw)return null;
  return {
    id:String(raw.id||createId()),
    name:String(raw.name||'未命名'),
    url:String(raw.url||''),
    image:typeof raw.image==='string'?raw.image:'',
    platform:typeof raw.platform==='string'?raw.platform:'',
    autoLogo:typeof raw.autoLogo==='string'?raw.autoLogo:'',
    likeCount:Number(raw.likeCount)||0,
    favoriteCount:Number(raw.favoriteCount)||0,
    likedByCurrentClient:Boolean(raw.likedByCurrentClient)
  };
}

function hostMatches(host, candidate){return host===candidate||host.endsWith(`.${candidate}`)}
function detectLogoMeta(rawUrl){
  const normalized=normalizeUrl(rawUrl);
  if(!normalized)return {platform:'',autoLogo:''};
  try{
    const parsed=new URL(normalized);const host=parsed.hostname.toLowerCase();
    const match=PLATFORM_RULES.find(rule=>rule.hosts.some(candidate=>hostMatches(host,candidate)));
    const fallback=`${GOOGLE_FAVICON_BASE}${encodeURIComponent(host)}&sz=128`;
    return {platform:match?.key||'',autoLogo:fallback};
  }catch(error){return {platform:'',autoLogo:''}}
}

function validateUrl(rawUrl){
  const value=String(rawUrl||'').trim();
  if(!value)return {ok:false,message:'请输入网站地址'};
  const candidate=/^[a-z][a-z\d+.-]*:\/\//i.test(value)?value:`https://${value}`;
  let parsed;
  try{parsed=new URL(candidate)}catch(error){return {ok:false,message:'网址格式不正确'} }
  if(!['http:','https:'].includes(parsed.protocol))return {ok:false,message:'只支持 HTTP 或 HTTPS 地址'};
  const host=parsed.hostname.toLowerCase();
  const isIPv4=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&host.split('.').every(part=>Number(part)<=255);
  const isIPv6=host.includes(':');
  const labels=host.split('.');
  const hasDomainSuffix=labels.length>=2&&labels.every(label=>/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))&&/^[a-z]{2,63}$/i.test(labels.at(-1));
  if(!isIPv4&&!isIPv6&&!hasDomainSuffix)return {ok:false,message:'请输入带域名后缀的网址，例如 example.com'};
  return {ok:true,url:parsed.href};
}

function normalizePage(raw){
  const page=createPage();
  const source=Array.isArray(raw?.slots)?raw.slots:Array.isArray(raw)?raw:[];
  source.slice(0,SLOTS_PER_PAGE).forEach((item,index)=>{page.slots[index]=copyIcon(item)})
  return page;
}

function normalizeState(raw){
  const result=createInitialState();
  if(raw&&Array.isArray(raw.pages))result.pages=raw.pages.map(normalizePage);
  if(!result.pages.length)result.pages=[createPage()];
  const seen=new Set();
  result.pages.forEach(page=>page.slots.forEach((item,index)=>{
    if(!item)return;
    if(seen.has(item.id))page.slots[index]=null;else seen.add(item.id);
  }));
  result.trash=Array.isArray(raw?.trash)?raw.trash.map(item=>({
    ...copyIcon(item),
    deletedAt:Number(item.deletedAt)||Date.now(),
    deletedBy:String(item.deletedBy||'anonymous')
  })):[];
  result.version=5;
  result.revision=Number(raw?.revision)||0;
  result.updatedAt=Number(raw?.updatedAt)||0;
  // Older records do not have logo metadata yet. Derive it in memory so they
  // receive the same display behavior without requiring manual re-editing.
  result.pages.forEach(page=>page.slots.forEach(item=>{
    if(!item)return;
    const detected=detectLogoMeta(item.url);
    if(!item.platform)item.platform=detected.platform;
    if(!item.autoLogo)item.autoLogo=detected.autoLogo;
  }));
  result.trash.forEach(item=>{
    const detected=detectLogoMeta(item.url);
    if(!item.platform)item.platform=detected.platform;
    if(!item.autoLogo)item.autoLogo=detected.autoLogo;
  });
  return result;
}

async function requestServer(method='GET',body,url=API_URL){
  const options={method,headers:{'Content-Type':'application/json','Cache-Control':'no-cache'}};
  if(body)options.body=JSON.stringify(body);
  const response=await fetch(url,options);
  const payload=await response.json().catch(()=>null);
  if(!response.ok){const error=new Error(payload?.error||`HTTP ${response.status}`);error.status=response.status;error.payload=payload;throw error}
  return payload;
}

async function loadState({quiet=false}={}){
  try{
    const payload=await requestServer('GET',undefined,`${API_URL}?clientId=${encodeURIComponent(clientId)}`);
    const remote=normalizeState(payload);
    const needsLogoPersist=[...(payload.pages||[]).flatMap(page=>page?.slots||[]),...(payload.trash||[])].some(item=>{
      if(!item)return false;
      const detected=detectLogoMeta(item.url);
      return item.platform!==detected.platform||item.autoLogo!==detected.autoLogo;
    });
    state=remote;serverAvailable=true;
    // Remove old per-device copies after the SQLite-backed server has supplied the shared data.
    ['adiaoo_shared_desktop_cache_v4','adiaoo_desktop_pages_v3','adiaoo_desktop_icons_v2'].forEach(key=>localStorage.removeItem(key));
    renderAll();
    if(needsLogoPersist)queueSave('logo-metadata');
    if(!quiet)toast('已从共享存储刷新');
  }catch(error){
    serverAvailable=false;
    if(!quiet)toast('共享数据库暂时不可用');
  }
}

function queueSave(reason){
  // The server checks revisions before replacing shared desktop and trash state.
  saveChain=saveChain.then(async()=>{
    if(!serverAvailable)return;
    const baseRevision=state.revision;
    try{
      const remote=normalizeState(await requestServer('PUT',{...state,baseRevision,reason,clientId}));
      state=remote;renderAll();
    }catch(error){
      if(error.status===409&&error.payload?.state){
        state=normalizeState(error.payload.state);renderAll();toast('其他用户刚刚修改了桌面，已刷新最新版本');
      }else{
        serverAvailable=false;toast('服务器保存失败，已保留本地缓存');
      }
    }
  });
  return saveChain;
}

function isMobile(){return matchMedia('(max-width:700px), (pointer:coarse)').matches}
function gridMetrics(page){
  const root=getComputedStyle(document.documentElement);
  const pageWidth=page?.clientWidth||desktop.clientWidth||window.innerWidth;
  const pageHeight=page?.clientHeight||desktop.clientHeight||window.innerHeight;
  const mobile=isMobile();
  const baseWidth=mobile?88:108;
  const baseHeight=mobile?108:118;
  const dockReserve=isMobile()?112:148;
  const usableHeight=Math.max(baseHeight,pageHeight-dockReserve);
  const availableWidth=Math.max(baseWidth,pageWidth-GRID_PADDING*2);
  const widthColumns=Math.max(1,Math.floor(availableWidth/baseWidth));
  const heightRows=Math.max(1,Math.floor((usableHeight-18)/baseHeight));
  // The grid grows with the viewport. Desktop uses every column that fits;
  // mobile keeps its four-column phone layout.
  const columnCount=mobile?Math.min(4,widthColumns):widthColumns;
  const rowCount=heightRows;
  const cellWidth=Math.max(baseWidth,Math.min(132,availableWidth/Math.max(1,columnCount)));
  const cellHeight=baseHeight;
  return {cellWidth,cellHeight,columnCount,rowCount,pageWidth,pageHeight,usableHeight,originX:GRID_PADDING,originY:18};
}
function slotPoint(slot,page){
  const {cellWidth,cellHeight,columnCount,originX,originY}=gridMetrics(page);
  const col=slot%columnCount,row=Math.floor(slot/columnCount);
  return {x:originX+col*cellWidth,y:originY+row*cellHeight};
}
function setEditMode(active){
  editMode=active;
  document.body.classList.toggle('edit-mode',active);
  document.querySelectorAll('.icon').forEach(icon=>icon.classList.toggle('editing',active));
}

function currentPageData(){return state.pages[currentPage]||state.pages[0]}
function findIcon(id){
  for(let page=0;page<state.pages.length;page++)for(let slot=0;slot<SLOTS_PER_PAGE;slot++)if(state.pages[page].slots[slot]?.id===id)return {item:state.pages[page].slots[slot],page,slot,logicalIndex:page*SLOTS_PER_PAGE+slot};
  return null;
}
function allLogicalSlots(){
  const slots=state.pages.flatMap(page=>page.slots.slice());
  while(slots.length>1&&!slots.at(-1))slots.pop();
  return slots;
}

function layoutCapacity(page){
  const metrics=gridMetrics(page);
  return Math.max(1,metrics.columnCount*metrics.rowCount);
}

function logicalIndex(pageIndex,slotIndex){return pageIndex*layoutCapacity(desktop)+slotIndex}
function pageCount(){return pagesTrack.children.length}

function responsivePages(sourceSlots,capacity,minimumPages=1){
  const pages=[];
  for(let index=0;index<sourceSlots.length;index+=capacity){
    const page=createPage();
    page.logicalStart=index;
    page.visibleSlots=sourceSlots.slice(index,index+capacity);
    pages.push(page);
  }
  while(pages.length<minimumPages){const page=createPage();page.logicalStart=pages.length*capacity;page.visibleSlots=[];pages.push(page)}
  return pages.length?pages:[createPage()];
}

function renderAll(){
  // The saved slot sequence is kept intact. Rendering repaginates that sequence
  // for the current viewport, so narrow screens spill into later pages without
  // deleting intentional empty cells.
  dragLayer?.replaceChildren();
  const oldCapacity=renderedCapacity||layoutCapacity(desktop);
  const oldPageStart=currentPage*oldCapacity;
  const focusId=pagesTrack.querySelector(`.desktop-page[data-page="${currentPage}"] .icon.selected`)?.dataset.id||selectedId;
  pagesTrack.replaceChildren();
  const ranking=false;
  const capacity=layoutCapacity(desktop);
  const logicalSlots=allLogicalSlots();
  const pages=responsivePages(logicalSlots,capacity,state.pages.length);
  if(!ranking){
    currentPage=Math.floor(oldPageStart/capacity);
    if(focusId){const index=logicalSlots.findIndex(item=>item?.id===focusId);if(index>=0)currentPage=Math.floor(index/capacity)}
  }
  renderedCapacity=capacity;
  pagesTrack.style.setProperty('--page-count',String(pages.length));
  pages.forEach((page,pageIndex)=>{
    const pageNode=document.createElement('section');
    pageNode.className='desktop-page'+(ranking?' ranking-page':'');pageNode.dataset.page=String(pageIndex);
    pageNode.setAttribute('aria-label',ranking?'排名榜单':`桌面第 ${pageIndex+1} 页`);
    const metrics=gridMetrics(desktop);
    pageNode.style.setProperty('--grid-columns',String(metrics.columnCount));
    pageNode.dataset.logicalStart=String(page.logicalStart??pageIndex*capacity);
    page.visibleSlots.forEach((item,slot)=>{if(item)pageNode.appendChild(renderIcon(item,pageIndex,slot,pageNode,false,page.logicalStart+slot))});
    pagesTrack.appendChild(pageNode);
  });
  document.body.classList.toggle('ranking-mode',ranking);
  document.body.classList.toggle('like-mode',likeMode);
  document.body.classList.toggle('favorite-mode',favoriteMode);
  currentPage=Math.min(currentPage,pages.length-1);
  setPage(ranking?0:currentPage,false);renderDots();
}

function rankedIcons(){
  return state.pages.flatMap((page,pageIndex)=>page.slots.map((item,slot)=>item?{item,pageIndex,slot}:null).filter(Boolean))
    .filter(entry=>entry.item.likeCount>=RANKING_THRESHOLD)
    .sort((a,b)=>b.item.likeCount-a.item.likeCount||a.item.name.localeCompare(b.item.name,'zh-CN'));
}

let renderedCapacity=0;

function renderIcon(item,pageIndex,slot,pageNode,ranking=false,logicalSlot=null){
  const icon=document.createElement('div');
  const point=slotPoint(slot,pageNode);
  icon.className='icon'+(item.id===selectedId?' selected':'')+(editMode?' editing':'')+((likeMode||favoriteMode)?' editing':'');
  icon.dataset.id=item.id;icon.dataset.page=String(pageIndex);icon.dataset.slot=String(slot);icon.dataset.logicalIndex=String(logicalSlot??slot);icon.tabIndex=0;icon.setAttribute('role','button');icon.setAttribute('aria-label',item.name);
  icon.style.left=`${point.x}px`;icon.style.top=`${point.y}px`;
  const imageBox=document.createElement('div');imageBox.className='icon-image';
  const detected=detectLogoMeta(item.url);
  const platform=item.platform||detected.platform;
  const autoLogo=item.autoLogo||detected.autoLogo;
  const mainImage=item.image||autoLogo;
  if(mainImage){
    const image=document.createElement('img');image.className='main-icon-image';image.src=mainImage;image.alt='';
    image.addEventListener('error',()=>{
      image.remove();
      if(!item.image&&autoLogo){
        const alternate=ruleFavicon(platform,autoLogo);
        if(alternate&&alternate!==autoLogo){image.src=alternate;imageBox.insertBefore(image,imageBox.firstChild);return}
      }
      if(!imageBox.querySelector('.main-icon-image'))imageBox.insertBefore(document.createTextNode(initials(item.name)),imageBox.firstChild);
    },{once:true});
    imageBox.appendChild(image);
  }else imageBox.textContent=initials(item.name);
  // A detected logo becomes a corner badge only when the user supplied the
  // main image. Without a custom image, it is already the main icon.
  if(autoLogo&&item.image){
    const badge=document.createElement('img');badge.className='platform-badge';badge.src=platformLogo(platform)||autoLogo;badge.alt='';badge.setAttribute('aria-hidden','true');
    badge.addEventListener('error',()=>badge.remove(),{once:true});
    imageBox.appendChild(badge);
  }
  const label=document.createElement('div');label.className='icon-label';label.textContent=item.name;
  icon.append(imageBox,label);
  if(ranking){const score=document.createElement('div');score.className='ranking-score';score.textContent=`♥ ${item.likeCount}`;icon.appendChild(score)}
  if(likeMode||favoriteMode){
    const heart=document.createElement('button');heart.type='button';heart.className='icon-like-button'+(item.likedByCurrentClient?' liked':'');heart.setAttribute('aria-label',item.likedByCurrentClient?'已点赞':'点赞');heart.innerHTML='♥';
    if(favoriteMode){const marked=isFavorite(item.id);heart.classList.add('favorite-marker');heart.classList.toggle('favorited',marked);heart.innerHTML=marked?'★':'☆';heart.setAttribute('aria-label',marked?'取消收藏':'收藏')}
    heart.addEventListener('pointerdown',event=>event.stopPropagation());
    heart.addEventListener('click',event=>{event.stopPropagation();favoriteMode?toggleFavorite(item.id):submitLike(item.id)});
    icon.appendChild(heart);
  }
  bindIcon(icon);return icon;
}

function platformLogo(platform){return PLATFORM_RULES.find(entry=>entry.key===platform)?.logo||''}
function ruleFavicon(platform,autoLogo){
  const rule=PLATFORM_RULES.find(entry=>entry.key===platform);
  if(!rule)return '';
  const host=rule.hosts[0];
  return `${GOOGLE_FAVICON_BASE}${encodeURIComponent(host)}&sz=128`||autoLogo;
}

function renderDots(){
  pageDots.replaceChildren();
  if(viewMode==='ranking'){pageDots.hidden=true;return}
  pageDots.hidden=false;
  const pageCount=pagesTrack.children.length;
  Array.from({length:pageCount},(_,index)=>{
    const dot=document.createElement('button');dot.className=`page-dot${index===currentPage?' active':''}`;dot.type='button';dot.setAttribute('aria-label',`第 ${index+1} 页`);dot.setAttribute('aria-current',index===currentPage?'true':'false');dot.addEventListener('click',()=>setPage(index));pageDots.appendChild(dot);
  });
}

function setPage(index,animate=true){
  if(viewMode==='ranking'){currentPage=0;pagesTrack.style.transition='none';pagesTrack.style.transform='translate3d(0,0,0)';return}
  currentPage=Math.max(0,Math.min(Math.max(0,pagesTrack.children.length-1),index));
  pagesTrack.style.transition=animate?'transform .42s cubic-bezier(.22,.72,.18,1)':'none';
  // pages-track 的宽度就是视口宽度，每个页面也是 100% 视口，所以每页移动 100%。
  pagesTrack.style.transform=`translate3d(${-currentPage*100}%,0,0)`;
  renderDots();
}

function slotFromPoint(pageIndex,clientX,clientY){
  const page=document.querySelector(`.desktop-page[data-page="${pageIndex}"]`);if(!page)return 0;
  const rect=page.getBoundingClientRect();
  const {cellWidth,cellHeight,columnCount,rowCount,originX,originY}=gridMetrics(page);
  const col=Math.max(0,Math.min(columnCount-1,Math.floor((clientX-rect.left-originX)/cellWidth)));
  const row=Math.max(0,Math.min(rowCount-1,Math.floor((clientY-rect.top-originY)/cellHeight)));
  return Math.min(layoutCapacity(page)-1,row*columnCount+col);
}

function storeLogicalSlots(slots){
  while(slots.length>1&&!slots.at(-1))slots.pop();
  const pageCount=Math.max(1,Math.ceil(slots.length/SLOTS_PER_PAGE));
  state.pages=Array.from({length:pageCount},(_,pageIndex)=>({slots:Array.from({length:SLOTS_PER_PAGE},(_,slot)=>slots[pageIndex*SLOTS_PER_PAGE+slot]||null)}));
}

function moveLogicalSlot(sourceIndex,targetIndex){
  const slots=allLogicalSlots();
  if(sourceIndex===targetIndex)return false;
  const source=slots[sourceIndex];if(!source)return false;
  slots[sourceIndex]=null;
  if(!slots[targetIndex])slots[targetIndex]=source;
  else if(sourceIndex<targetIndex){
    for(let index=sourceIndex+1;index<=targetIndex;index++)slots[index-1]=slots[index];
    slots[targetIndex]=source;
  }else{
    for(let index=sourceIndex-1;index>=targetIndex;index--)slots[index+1]=slots[index];
    slots[targetIndex]=source;
  }
  storeLogicalSlots(slots);return true;
}

function createAtCurrentPage(item){
  const slots=allLogicalSlots(),capacity=layoutCapacity(desktop),start=currentPage*capacity;
  let slot=-1;
  for(let index=start;index<start+capacity;index++)if(!slots[index]){slot=index;break}
  if(slot<0){slot=start+capacity;slots.length=Math.max(slots.length,slot+1);currentPage=Math.floor(slot/capacity)}
  slots[slot]=item;storeLogicalSlots(slots);
}

function clearEdgePageTimer(){
  clearTimeout(edgeTimer);edgeTimer=null;edgeDirection=0;
}

function previewLogicalSlots(session,targetIndex){
  const slots=allLogicalSlots(),source=slots[session.sourceIndex];
  if(!source)return slots;
  slots[session.sourceIndex]=null;
  if(!slots[targetIndex])slots[targetIndex]=source;
  else if(session.sourceIndex<targetIndex){
    for(let index=session.sourceIndex+1;index<=targetIndex;index++)slots[index-1]=slots[index];
    slots[targetIndex]=source;
  }else{
    for(let index=session.sourceIndex-1;index>=targetIndex;index--)slots[index+1]=slots[index];
    slots[targetIndex]=source;
  }
  return slots;
}

function applyDragPreview(session,targetIndex){
  if(session.previewIndex===targetIndex)return;
  const slots=previewLogicalSlots(session,targetIndex),capacity=layoutCapacity(desktop);
  const nodes=new Map([...document.querySelectorAll('.desktop-page .icon')].map(icon=>[icon.dataset.id,icon]));
  slots.forEach((item,index)=>{
    if(!item||item.id===session.id)return;
    const pageIndex=Math.floor(index/capacity),slot=index%capacity;
    const page=document.querySelector(`.desktop-page[data-page="${pageIndex}"]`);
    if(!page)return;
    const icon=nodes.get(item.id);if(!icon)return;
    if(icon.parentElement!==page)page.appendChild(icon);
    const point=slotPoint(slot,page);
    icon.dataset.page=String(pageIndex);icon.dataset.slot=String(slot);icon.dataset.logicalIndex=String(index);
    icon.style.position='absolute';icon.style.left=`${point.x}px`;icon.style.top=`${point.y}px`;icon.style.zIndex='1';
  });
  session.previewIndex=targetIndex;
}

function updateDraggedIcon(session,event){
  session.lastX=event.clientX;session.lastY=event.clientY;
  session.el.style.left=`${event.clientX-session.offsetX}px`;
  session.el.style.top=`${event.clientY-session.offsetY}px`;
  const targetPage=currentPage;
  const page=document.querySelector(`.desktop-page[data-page="${targetPage}"]`);
  const metrics=gridMetrics(page);
  const targetSlot=slotFromPoint(targetPage,event.clientX-session.offsetX+metrics.cellWidth/2,event.clientY-session.offsetY+metrics.cellHeight/2);
  session.targetIndex=logicalIndex(targetPage,targetSlot);
  applyDragPreview(session,session.targetIndex);
  maybeTurnPageWhileDragging(session,event.clientX);
}

function maybeTurnPageWhileDragging(session,clientX){
  // Edge paging is delayed so a small hand movement does not change pages unexpectedly.
  const edge=Math.max(42,Math.min(86,window.innerWidth*.08));
  const direction=clientX<edge?-1:clientX>window.innerWidth-edge?1:0;
  if(!direction||((direction<0&&currentPage===0)||(direction>0&&currentPage===pagesTrack.children.length-1))){clearEdgePageTimer();return}
  if(edgeTimer&&edgeDirection===direction)return;
  clearEdgePageTimer();edgeDirection=direction;
  edgeTimer=setTimeout(()=>{
    edgeTimer=null;edgeDirection=0;
    if(dragSession!==session||!session.dragStarted)return;
    let next=currentPage+direction;
    if(next<0)return;
    if(next>=pageCount()){
      ensureResponsivePage(next);
      next=currentPage+direction;
    }
    setPage(next,false);
    animatePageTrackTo(next);
    const page=document.querySelector(`.desktop-page[data-page="${next}"]`);
    const metrics=gridMetrics(page);
    const slot=slotFromPoint(next,session.lastX-session.offsetX+metrics.cellWidth/2,session.lastY-session.offsetY+metrics.cellHeight/2);
    session.targetIndex=logicalIndex(next,slot);
    applyDragPreview(session,session.targetIndex);
  },340);
}

function ensureResponsivePage(index){
  if(index<pageCount())return;
  const capacity=layoutCapacity(desktop);
  const slots=allLogicalSlots();
  while(slots.length<(index+1)*capacity)slots.push(null);
  storeLogicalSlots(slots);
  renderAll();
}

function animatePageTrackTo(index){
  pagesTrack.style.transition='transform .42s cubic-bezier(.22,.72,.18,1)';
  pagesTrack.style.transform=`translate3d(${-index*100}%,0,0)`;
  renderDots();
}

function activateLongPress(session){
  if(dragSession!==session)return;
  session.longPressed=true;session.el.classList.add('long-pressing');
  try{session.el.setPointerCapture(session.pointerId)}catch(error){}
}

function startIconDrag(session,event){
  if(session.dragStarted)return;
  session.dragStarted=true;session.moved=true;session.el.classList.add('dragging');session.el.classList.remove('long-pressing');
  dragLayer.appendChild(session.el);
  session.el.style.position='absolute';session.el.style.zIndex='90';
  try{session.el.setPointerCapture(session.pointerId)}catch(error){}
  updateDraggedIcon(session,event);
}

function handleIconPointerMove(event){
  const session=dragSession;
  if(!session||session.pointerId!==event.pointerId)return;
  const dx=event.clientX-session.startX,dy=event.clientY-session.startY;
  const distance=Math.hypot(dx,dy);
  if(!session.longPressed){
    if(distance<=MOVE_CANCEL_DISTANCE)return;
    clearTimeout(session.timer);
    if(interactionMode(event)==='desktop'){
      session.longPressed=true;
      activateLongPress(session);
      startIconDrag(session,event);
      event.preventDefault();event.stopPropagation();
      return;
    }
    if(interactionMode(event)==='mobile'&&Math.abs(dx)>Math.abs(dy)){
      dragSession=null;beginPageSwipe(event);event.preventDefault();
    }else{
      session.el.classList.remove('long-pressing');dragSession=null;
    }
    return;
  }
  if(!session.dragStarted&&distance>=DRAG_START_DISTANCE)startIconDrag(session,event);
  if(!session.dragStarted)return;
  event.preventDefault();event.stopPropagation();updateDraggedIcon(session,event);
}

function finishIconPress(event,canceled=false){
  const current=dragSession;
  if(!current||current.pointerId!==event.pointerId)return;
  clearTimeout(current.timer);clearEdgePageTimer();
  try{if(current.el.hasPointerCapture?.(current.pointerId))current.el.releasePointerCapture(current.pointerId)}catch(error){}
  dragSession=null;
  const found=findIcon(current.id);
  if(!found||canceled){renderAll();return}
  if(current.dragStarted){
    const targetPage=current.targetPage??currentPage;
    const page=document.querySelector(`.desktop-page[data-page="${targetPage}"]`);
    const metrics=gridMetrics(page);
    const targetSlot=current.targetSlot??slotFromPoint(targetPage,current.lastX-current.offsetX+metrics.cellWidth/2,current.lastY-current.offsetY+metrics.cellHeight/2);
    const targetIndex=current.targetIndex??logicalIndex(targetPage,targetSlot);
    if(moveLogicalSlot(found.logicalIndex,targetIndex)){queueSave('move');toast('图标位置已保存')}
    current.el.classList.remove('dragging','long-pressing');
    current.el.style.cssText='';
    renderAll();return;
  }
  if(current.longPressed){
    current.el.classList.remove('long-pressing');
    renderAll();showIconActions(event.clientX,event.clientY,current.id);return;
  }
  if(interactionMode(event)==='mobile'){
    openItem(found.item);
    renderAll();
  }
}

function bindIcon(icon){
  const id=icon.dataset.id;
  icon.addEventListener('pointerdown',event=>{
    if(likeMode||viewMode==='ranking')return;
    if(event.pointerType==='mouse'&&event.button!==0)return;
    selectedId=id;hideContextMenu();
    icon.classList.add('selected');
    const rect=icon.getBoundingClientRect();
    const session={id,el:icon,pointerId:event.pointerId,pointerType:event.pointerType,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,offsetX:event.clientX-rect.left,offsetY:event.clientY-rect.top,sourcePage:Number(icon.dataset.page),sourceSlot:Number(icon.dataset.slot),sourceIndex:Number(icon.dataset.logicalIndex),targetPage:currentPage,targetSlot:Number(icon.dataset.slot),targetIndex:Number(icon.dataset.logicalIndex),previewIndex:null,longPressed:false,dragStarted:false,timer:null};
    dragSession=session;
    if(event.pointerType==='touch'||event.pointerType==='pen')beginPageSwipe(event);
    session.timer=setTimeout(()=>activateLongPress(session),LONG_PRESS_MS);
  });
  icon.addEventListener('dblclick',event=>{
    if(event.pointerType!=='touch'&&!dragSession?.dragStarted)openItem(findIcon(id)?.item);
  });
  icon.addEventListener('contextmenu',event=>{
    event.preventDefault();
    if(interactionMode(event)==='desktop')showIconActions(event.clientX,event.clientY,id);
  });
  icon.addEventListener('keydown',event=>{if(event.key==='Enter')openItem(findIcon(id)?.item)});
}

function beginPageSwipe(event){
  if(viewMode==='ranking'||likeMode||dragSession?.dragStarted)return;
  pageSwipe={startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,pointerId:event.pointerId,started:false,startedAt:performance.now(),lastAt:performance.now()};
  try{desktop.setPointerCapture(event.pointerId)}catch(error){}
}
function finishPageSwipe(event){
  if(!pageSwipe||pageSwipe.pointerId!==event.pointerId)return;
  const session=pageSwipe;const delta=session.lastX-session.startX;const elapsed=Math.max(1,performance.now()-session.startedAt);const velocity=delta/elapsed;pageSwipe=null;
  try{if(desktop.hasPointerCapture?.(event.pointerId))desktop.releasePointerCapture(event.pointerId)}catch(error){}
  if(session.started){
    const direction=delta<0?1:-1;
    const shouldAdvance=Math.abs(delta)>Math.min(90,window.innerWidth*.18)||Math.abs(velocity)>.45;
    setPage(currentPage+(shouldAdvance?direction:0),true);
  }else setPage(currentPage,true);
}

function normalizeUrl(raw){
  const result=validateUrl(raw);
  return result.ok?result.url:'';
}
function initials(name){const text=String(name||'').trim();return text?text.slice(0,2).toUpperCase():'A'}
function openItem(item){const url=normalizeUrl(item?.url);if(!url){toast('网址格式不正确');return}window.open(url,'_blank','noopener,noreferrer')}

function setLikeMode(active){
  likeMode=active;favoriteMode=false;
  if(active)setEditMode(false);
  renderAll();
}

function setFavoriteMode(active){favoriteMode=active;likeMode=false;if(active)setEditMode(false);renderAll()}
async function toggleFavorite(id){const found=findIcon(id);if(!found)return;const was=isFavorite(id);if(was){removeFavorite(id);renderAll();toast('已取消收藏');return}const pending=saveFavorite(found.item);renderAll();try{await pending;renderAll();toast('已加入收藏')}catch(error){toast('收藏计数未能同步，请稍后刷新')}}

async function submitLike(iconId){
  const found=findIcon(iconId);
  if(!found)return;
  if(found.item.likedByCurrentClient){setLikeMode(false);toast('这个图标已经点过赞');return}
  try{
    const response=await requestServer('POST',{iconId,clientId},`${API_URL.replace(/\/$/,'')}/like`);
    const likeSnapshot=iconSnapshot(found.item);
    likeSnapshot.likeCount=Number(response.likeCount)||likeSnapshot.likeCount+1;
    likeSnapshot.likedByCurrentClient=true;
    const likedRows=localLikes().filter(entry=>entry.id!==iconId);
    likedRows.unshift(likeSnapshot);
    writeLocalJson(LIKED_ITEMS_KEY,likedRows);
    writeRankingSnapshot('likes',found.item,{likeCount:response.likeCount,likedByCurrentClient:true});
    state.pages.forEach(page=>page.slots.forEach(item=>{
      if(item?.id===iconId){item.likeCount=response.likeCount;item.likedByCurrentClient=true}
    }));
    state.revision=response.revision;
    likeMode=false;renderAll();if(rankingDialog?.open)renderRanking();toast('已为喜欢的图标点赞');
  }catch(error){
    toast(error.status===409?'桌面刚刚更新，请刷新后再试':'点赞没有保存，请检查共享数据库连接');
  }
}

function rankingRows(){
  const data=localRanking();
  const rows=(rankingTab==='favorites'?data.favorites:data.likes).map(item=>({...item}));
  const live=state.pages.flatMap(page=>page.slots).filter(Boolean);
  live.forEach(item=>{const row=rows.find(entry=>entry.id===item.id);if(row){row.likeCount=Math.max(row.likeCount||0,item.likeCount||0);row.favoriteCount=Math.max(row.favoriteCount||0,item.favoriteCount||0)}});
  return rows.sort((a,b)=>rankingTab==='favorites'?((b.favoriteCount||0)-(a.favoriteCount||0)||((b.likeCount||0)-(a.likeCount||0))):((b.likeCount||0)-(a.likeCount||0)||((b.favoriteCount||0)-(a.favoriteCount||0))));
}
async function syncSnapshotCounts(rows){
  const ids=[...new Set(rows.map(item=>item.id).filter(Boolean))];
  if(!ids.length)return rows;
  try{
    const response=await requestServer('GET',undefined,`${API_URL.replace(/\/$/,'')}/counts?clientId=${encodeURIComponent(clientId)}&ids=${encodeURIComponent(ids.join(','))}`);
    const counts=response?.counts||{};
    const data=localRanking();
    ['likes','favorites'].forEach(type=>{data[type]=(data[type]||[]).map(item=>counts[item.id]?{...item,...counts[item.id]}:item)});
    writeLocalJson(RANKING_SNAPSHOTS_KEY,data);
    writeLocalJson(LIKED_ITEMS_KEY,localLikes().map(item=>counts[item.id]?{...item,...counts[item.id]}:item));
    const favoriteCounts=new Map(localFavorites().map(item=>[item.id,item]));
    favoriteCounts.forEach((item,id)=>{if(counts[id])Object.assign(item,counts[id])});
    writeLocalJson(FAVORITES_KEY,[...favoriteCounts.values()]);
    state.pages.forEach(page=>page.slots.forEach(item=>{if(item&&counts[item.id])Object.assign(item,counts[item.id])}));
    return rows.map(item=>counts[item.id]?{...item,...counts[item.id]}:item);
  }catch(error){return rows}
}
async function fetchRankingRows(){
  const sort=rankingTab==='favorites'?'favorites':'likes';
  try{
    const response=await requestServer('GET',undefined,`${API_URL.replace(/\/$/,'')}/ranking?sort=${sort}&clientId=${encodeURIComponent(clientId)}`);
    const rows=Array.isArray(response?.items)?response.items:[];
    if(rows.length){
      const data=localRanking();
      data[sort]=(data[sort]||[]).filter(item=>!rows.some(row=>row.id===item.id));
      data[sort].push(...rows);
      writeLocalJson(RANKING_SNAPSHOTS_KEY,data);
      return rows;
    }
  }catch(error){/* Keep the local snapshot fallback available when the ranking endpoint is offline. */}
  return rankingRows();
}
function renderRanking(rows=rankingRows()){
  const list=$('#rankingList');list.replaceChildren();
  if(!rows.length){const empty=document.createElement('div');empty.className='ranking-empty-message';empty.textContent=rankingTab==='favorites'?'还没有收藏记录':`暂时没有达到 ${RANKING_THRESHOLD} 个赞的图标`;list.appendChild(empty);return}
  rows.forEach(item=>{const row=document.createElement('article');row.className='ranking-row';const thumb=document.createElement('div');thumb.className='ranking-thumb';const source=item.image||item.autoLogo;if(source){const image=document.createElement('img');image.src=source;image.alt='';image.onerror=()=>{image.remove();thumb.textContent=initials(item.name)};thumb.appendChild(image)}else thumb.textContent=initials(item.name);const body=document.createElement('div');body.className='ranking-row-body';const name=document.createElement('strong');name.textContent=item.name;const url=document.createElement('div');url.className='ranking-url';url.textContent=item.url;const actions=document.createElement('div');actions.className='ranking-actions';const like=document.createElement('button');like.type='button';like.className='rank-like-button'+(item.likedByCurrentClient?' active':'');like.textContent=`${item.likeCount||0} ♥`;like.addEventListener('click',async()=>{await submitLike(item.id);renderRanking()});const fav=document.createElement('button');fav.type='button';fav.className='rank-favorite-button'+(isFavorite(item.id)?' active':'');fav.textContent=`${item.favoriteCount||0} ${isFavorite(item.id)?'★':'☆'}`;fav.addEventListener('click',async()=>{if(isFavorite(item.id)){removeFavorite(item.id);renderRanking()}else{try{await saveFavorite(item);renderRanking()}catch(error){toast('收藏计数保存失败')}}});const visit=document.createElement('button');visit.type='button';visit.textContent='访问';visit.addEventListener('click',()=>openItem(item));actions.append(like,fav,visit);body.append(name,url,actions);row.append(thumb,body);list.appendChild(row)})
}
function openRanking(){rankingTab='likes';$('#likeRankingTab').classList.add('active');$('#likeRankingTab').setAttribute('aria-selected','true');$('#favoriteRankingTab').classList.remove('active');$('#favoriteRankingTab').setAttribute('aria-selected','false');renderRanking();rankingDialog.showModal();fetchRankingRows().then(rows=>syncSnapshotCounts(rows).then(()=>renderRanking(rows)))}
function toggleRanking(){likeMode=false;favoriteMode=false;openRanking()}
function renderSnapshotRows(list,rows,type){
  list.replaceChildren();
  if(!rows.length){const empty=document.createElement('div');empty.className='ranking-empty-message';empty.textContent=type==='likes'?'喜欢列表为空':'收藏列表为空';list.appendChild(empty);return}
  rows.forEach(item=>{
    const row=document.createElement('article');row.className='favorite-row';
    const thumb=document.createElement('div');thumb.className='favorite-thumb';const source=item.image||item.autoLogo;
    if(source){const image=document.createElement('img');image.src=source;image.alt='';image.onerror=()=>{image.remove();thumb.textContent=initials(item.name)};thumb.appendChild(image)}else thumb.textContent=initials(item.name);
    const body=document.createElement('div');body.className='favorite-row-body';const name=document.createElement('strong');name.textContent=item.name;const url=document.createElement('span');url.textContent=item.url;body.append(name,url);
    const actions=document.createElement('div');actions.className='favorite-actions';const mark=document.createElement('button');mark.type='button';mark.className=type==='likes'?'like-state-button active':'favorite-state-button active';mark.textContent=type==='likes'?`${item.likeCount||0} ♥`:`${item.favoriteCount||0} ★`;
    mark.addEventListener('click',()=>{if(type==='likes')writeLocalJson(LIKED_ITEMS_KEY,localLikes().filter(entry=>entry.id!==item.id));else writeLocalJson(FAVORITES_KEY,localFavorites().filter(entry=>entry.id!==item.id));renderUserLists()});
    const visit=document.createElement('button');visit.type='button';visit.textContent='访问';visit.addEventListener('click',()=>openItem(item));actions.append(mark,visit);row.append(thumb,body,actions);list.appendChild(row);
  });
}
function renderUserLists(){
  renderSnapshotRows($('#userLikesList'),localLikes(),'likes');
  renderSnapshotRows($('#userFavoritesList'),localFavorites(),'favorites');
}
function setUserListTab(tab){
  userListTab=tab;const likes=tab==='likes';
  $('#likesListTab').classList.toggle('active',likes);$('#likesListTab').setAttribute('aria-selected',String(likes));
  $('#favoritesListTab').classList.toggle('active',!likes);$('#favoritesListTab').setAttribute('aria-selected',String(!likes));
  $('#userLikesList').hidden=!likes;$('#userFavoritesList').hidden=likes;
}
function openUserLists(){setUserListTab(userListTab);renderUserLists();favoritesDialog.showModal();const rows=userListTab==='likes'?localLikes():localFavorites();syncSnapshotCounts(rows).then(()=>renderUserLists())}

function closeDialogOnBackdrop(dialog){dialog?.addEventListener('click',event=>{if(event.target===dialog)dialog.close()})}

function openEditor(item=null){
  $('#iconDialogTitle').textContent=item?'编辑图标':'新建图标';$('#iconId').value=item?.id||'';$('#iconName').value=item?.name||'';$('#iconUrl').value=item?.url||'';$('#iconImage').value='';$('#iconImageUrl').value=item?.image||'';iconDialog.showModal();setTimeout(()=>$('#iconName').focus(),50)
}
function saveEditor(event){
  event.preventDefault();
  const name=$('#iconName').value.trim(),rawUrl=$('#iconUrl').value.trim(),id=$('#iconId').value;
  if(!name){toast('请输入图标名称');return}
  const checked=validateUrl(rawUrl);
  if(!checked.ok){toast(checked.message);$('#iconUrl').focus();return}
  const url=checked.url;
  const file=$('#iconImage').files?.[0],pastedImage=$('#iconImageUrl').value.trim();
  const finish=image=>{
    const logoMeta=detectLogoMeta(url);
    const finalImage=image!==undefined?image:pastedImage;
    if(id){const found=findIcon(id);if(found){found.item.name=name;found.item.url=url;found.item.platform=logoMeta.platform;found.item.autoLogo=logoMeta.autoLogo;found.item.image=finalImage}}
    else createAtCurrentPage({id:createId(),name,url,image:finalImage,...logoMeta});
    queueSave(id?'edit':'create');iconDialog.close();renderAll();toast(id?'图标已更新':'图标已创建');
  };
  if(file){const reader=new FileReader();reader.onload=()=>finish(String(reader.result||''));reader.readAsDataURL(file)}else finish(undefined);
}

function renderTrash(){
  const list=$('#trashList'),query=$('#trashSearch').value.trim().toLowerCase();list.replaceChildren();
  const matches=state.trash.filter(item=>[item.name,item.url,item.deletedBy,new Date(item.deletedAt).toLocaleString('zh-CN')].join(' ').toLowerCase().includes(query));
  if(!matches.length){const empty=document.createElement('div');empty.className='trash-empty';empty.textContent=query?'没有匹配记录':'回收站为空';list.appendChild(empty);return}
  matches.forEach(item=>{const row=document.createElement('div');row.className='trash-item';const thumb=document.createElement('div');thumb.className='trash-thumb';const imageSource=item.image||item.autoLogo;if(imageSource){const image=document.createElement('img');image.src=imageSource;image.alt='';image.addEventListener('error',()=>{image.remove();if(!thumb.querySelector('img'))thumb.textContent=initials(item.name)},{once:true});thumb.appendChild(image)}else thumb.textContent=initials(item.name);const copy=document.createElement('div');const name=document.createElement('div');name.className='trash-name';name.textContent=item.name;const meta=document.createElement('div');meta.className='trash-meta';meta.textContent=`${new Date(item.deletedAt).toLocaleString('zh-CN')} · ${item.url}`;copy.append(name,meta);row.append(thumb,copy);list.appendChild(row)})
}
function openTrash(){
  renderTrash();trashDialog.showModal();setTimeout(()=>$('#trashSearch').focus(),50);
}

function toast(message){const node=$('#toast');node.textContent=message;node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),1800)}
function showIconActions(x,y,id){
  actionMenuId=id;
  iconActionsMenu.classList.add('show');
  const width=iconActionsMenu.offsetWidth,height=iconActionsMenu.offsetHeight;
  iconActionsMenu.style.left=`${Math.min(window.innerWidth-width-8,Math.max(8,x))}px`;
  iconActionsMenu.style.top=`${Math.min(window.innerHeight-height-8,Math.max(35,y))}px`;
}
function hideContextMenu(){
  actionMenuId=null;
  iconActionsMenu.classList.remove('show');
}
function removeIcon(id){
  const found=findIcon(id);if(!found)return;
  if(!confirm(`将“${found.item.name}”从桌面移除？`))return;
  state.pages[found.page].slots[found.slot]=null;
  state.trash.unshift({...found.item,deletedAt:Date.now(),deletedBy:clientId});
  selectedId=null;hideContextMenu();queueSave('trash');renderAll();toast('已移入回收站');
}

function updateClock(){const now=new Date();$('#clock').textContent=`${now.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric',weekday:'short'})} ${now.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}`}

$('#createButton').addEventListener('click',()=>openEditor());
$('#refreshButton').addEventListener('click',()=>loadState());
trashButton.addEventListener('click',openTrash);
$('#rankingButton').addEventListener('click',toggleRanking);
$('#likeButton').addEventListener('click',()=>setLikeMode(!likeMode));
$('#favoriteButton').addEventListener('click',()=>setFavoriteMode(!favoriteMode));
$('#userListsButton').addEventListener('click',openUserLists);
$('#helpButton').addEventListener('click',()=>helpDialog.showModal());
$('#helpDialogClose').addEventListener('click',()=>helpDialog.close());
$('#trashDialogClose').addEventListener('click',()=>trashDialog.close());
$('#rankingDialogClose').addEventListener('click',()=>rankingDialog.close());
$('#favoritesDialogClose').addEventListener('click',()=>favoritesDialog.close());
$('#likeRankingTab').addEventListener('click',()=>{rankingTab='likes';$('#likeRankingTab').classList.add('active');$('#likeRankingTab').setAttribute('aria-selected','true');$('#favoriteRankingTab').classList.remove('active');$('#favoriteRankingTab').setAttribute('aria-selected','false');renderRanking();fetchRankingRows().then(rows=>syncSnapshotCounts(rows).then(()=>renderRanking(rows)))});
$('#favoriteRankingTab').addEventListener('click',()=>{rankingTab='favorites';$('#favoriteRankingTab').classList.add('active');$('#favoriteRankingTab').setAttribute('aria-selected','true');$('#likeRankingTab').classList.remove('active');$('#likeRankingTab').setAttribute('aria-selected','false');renderRanking();fetchRankingRows().then(rows=>syncSnapshotCounts(rows).then(()=>renderRanking(rows)))});
$('#likesListTab').addEventListener('click',()=>{setUserListTab('likes');renderUserLists();syncSnapshotCounts(localLikes()).then(renderUserLists)});
$('#favoritesListTab').addEventListener('click',()=>{setUserListTab('favorites');renderUserLists();syncSnapshotCounts(localFavorites()).then(renderUserLists)});
closeDialogOnBackdrop(rankingDialog);closeDialogOnBackdrop(favoritesDialog);closeDialogOnBackdrop(trashDialog);closeDialogOnBackdrop(iconDialog);closeDialogOnBackdrop(helpDialog);
$('#iconDialogClose').addEventListener('click',()=>iconDialog.close());
$('#iconDialogCancel').addEventListener('click',()=>iconDialog.close());
$('#iconForm').addEventListener('submit',saveEditor);
$('#iconImageChoose').addEventListener('click',()=>$('#iconImage').click());
$('#iconImage').addEventListener('change',event=>{
  const file=event.target.files?.[0];if(!file)return;
  const reader=new FileReader();reader.onload=()=>{$('#iconImageUrl').value=String(reader.result||'')};reader.readAsDataURL(file);
});
$('#iconImageUrl').addEventListener('paste',event=>{
  const image=[...(event.clipboardData?.items||[])].find(item=>item.type.startsWith('image/'));
  if(!image)return;
  event.preventDefault();const file=image.getAsFile();if(!file)return;
  const reader=new FileReader();reader.onload=()=>{$('#iconImageUrl').value=String(reader.result||'')};reader.readAsDataURL(file);
});
$('#trashSearch').addEventListener('input',renderTrash);
iconActionsMenu.addEventListener('click',event=>{
  const action=event.target.closest('[data-action]')?.dataset.action;
  const id=actionMenuId;
  hideContextMenu();
  if(action==='info')openEditor(findIcon(id)?.item);
  if(action==='visit')openItem(findIcon(id)?.item);
  if(action==='remove')removeIcon(id);
});

desktop.addEventListener('pointermove',event=>{
  if(dragSession&&dragSession.pointerId===event.pointerId){
    handleIconPointerMove(event);
    if(dragSession?.dragStarted)return;
    if(pageSwipe?.pointerId===event.pointerId){
      pageSwipe.lastX=event.clientX;pageSwipe.lastY=event.clientY;pageSwipe.lastAt=performance.now();
      const delta=event.clientX-pageSwipe.startX,vertical=Math.abs(event.clientY-pageSwipe.startY);
      if(!pageSwipe.started&&Math.abs(delta)>8&&Math.abs(delta)>vertical){
        clearTimeout(dragSession.timer);dragSession.el.classList.remove('long-pressing');dragSession=null;pageSwipe.started=true;
      }
      if(pageSwipe?.started){
        event.preventDefault();pagesTrack.style.transition='none';
        const bounded=Math.max(-window.innerWidth,Math.min(window.innerWidth,delta));
        pagesTrack.style.transform=`translate3d(calc(${-currentPage*100}% + ${bounded}px),0,0)`;
      }
    }
    return;
  }
  if(!pageSwipe||pageSwipe.pointerId!==event.pointerId)return;
  pageSwipe.lastX=event.clientX;
  pageSwipe.lastY=event.clientY;
  pageSwipe.lastAt=performance.now();
  const delta=event.clientX-pageSwipe.startX;
  const vertical=Math.abs(event.clientY-pageSwipe.startY);
  if(!pageSwipe.started&&Math.abs(delta)>8&&Math.abs(delta)>vertical){pageSwipe.started=true}
  if(pageSwipe.started){
    event.preventDefault();
    pagesTrack.style.transition='none';
    const limit=window.innerWidth;
    const bounded=Math.max(-limit,Math.min(limit,delta));
    pagesTrack.style.transform=`translate3d(calc(${-currentPage*100}% + ${bounded}px),0,0)`;
  }
},{passive:false});
document.addEventListener('pointerup',event=>{
  if(dragSession&&dragSession.pointerId===event.pointerId)finishIconPress(event);
  if(pageSwipe&&pageSwipe.pointerId===event.pointerId)finishPageSwipe(event);
});
document.addEventListener('pointercancel',event=>{
  if(dragSession&&dragSession.pointerId===event.pointerId)finishIconPress(event,true);
  if(pageSwipe&&pageSwipe.pointerId===event.pointerId){pageSwipe=null;setPage(currentPage)}
});
desktop.addEventListener('pointerdown',event=>{
  if(event.target.closest('#dock'))return;
  if(likeMode||favoriteMode){setLikeMode(false);setFavoriteMode(false);return}
  if(viewMode==='ranking')return;
  if(!event.target.closest('.icon')){
    selectedId=null;document.querySelectorAll('.icon.selected').forEach(icon=>icon.classList.remove('selected'));setEditMode(false);hideContextMenu();
  }
  // Desktop mouse and touchpad drags use the same page gesture as touch.
  // A pointer on an icon is claimed by bindIcon and can become icon dragging.
  if(!event.target.closest('.icon'))beginPageSwipe(event);
});
window.addEventListener('resize',()=>{
  if(dragSession){clearTimeout(dragSession.timer);dragSession=null;clearEdgePageTimer()}
  renderAll();
});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.context-menu'))hideContextMenu()});
document.addEventListener('lostpointercapture',event=>{
  if(dragSession?.pointerId===event.pointerId){clearTimeout(dragSession.timer);dragSession=null;clearEdgePageTimer();renderAll()}
  if(pageSwipe?.pointerId===event.pointerId){pageSwipe=null;setPage(currentPage,true)}
});

updateClock();setInterval(updateClock,1000);
renderAll();
loadState({quiet:true});
