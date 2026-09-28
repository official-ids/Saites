export default function handler(req, res) {
  const raw = req.query.display || 'hello';
  const mode = String(req.query.mode || 'rainbow').toLowerCase().replace(/[^a-z0-9_]/g, '');
  
  const safe = String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  let css = '';
  let html = '';
  let js = '';
  let bodyStyle = 'background:#111;color:#fff;font-family:monospace;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;overflow:hidden;';

  switch (mode) {
    case 'rainbow':
      css = `.t{background:linear-gradient(90deg,red,orange,yellow,green,blue,indigo,violet,red);background-size:400%;-webkit-background-clip:text;color:transparent;animation:r 3s linear infinite;font-size:5rem;font-weight:bold;}@keyframes r{0%{background-position:0%}100%{background-position:400%}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'matrix':
      bodyStyle = 'background:#000;color:#0f0;font-family:monospace;';
      css = `.t{font-size:4rem;text-shadow:0 0 10px #0f0;animation:m 0.1s infinite;}@keyframes m{0%{opacity:1}50%{opacity:0.8}100%{opacity:1}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'glitch':
      css = `.t{font-size:5rem;font-weight:bold;position:relative;color:#fff;animation:g 1s infinite;}@keyframes g{0%{text-shadow:2px 0 red,-2px 0 blue}25%{text-shadow:-2px 0 red,2px 0 blue}50%{text-shadow:2px 2px red,-2px -2px blue}75%{text-shadow:-2px 2px red,2px -2px blue}100%{text-shadow:2px 0 red,-2px 0 blue}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'shake':
      css = `.t{font-size:5rem;font-weight:bold;animation:s 0.5s infinite;}@keyframes s{0%,100%{transform:translate(0,0)}25%{transform:translate(-5px,5px)}50%{transform:translate(5px,-5px)}75%{transform:translate(-5px,-5px)}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'spin':
      css = `.t{font-size:5rem;font-weight:bold;animation:sp 2s linear infinite;}@keyframes sp{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'blink':
      css = `.t{font-size:5rem;font-weight:bold;animation:b 0.5s step-end infinite;}@keyframes b{50%{opacity:0}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'upside_down':
      css = `.t{font-size:5rem;font-weight:bold;transform:rotate(180deg);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'zalgo':
      css = `.t{font-size:4rem;font-family:"Courier New",monospace;letter-spacing:-5px;line-height:0.8;transform:scaleY(1.5);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'big':
      css = `.t{font-size:15rem;font-weight:900;color:#fff;word-break:break-all;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'tiny':
      css = `.t{font-size:0.4rem;color:#fff;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'comic':
      bodyStyle = 'background:#ffff00;color:#000;';
      css = `.t{font-family:"Comic Sans MS","Comic Sans",cursive;font-size:4rem;font-weight:bold;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'hacker':
      bodyStyle = 'background:#000;color:#0f0;';
      css = `.t{font-family:monospace;font-size:3rem;}`;
      html = `<div class="t">> ${safe}<span style="animation:b 0.5s infinite">_</span></div>`;
      break;
    case 'vaporwave':
      bodyStyle = 'background:linear-gradient(to bottom, #ff9a9e, #fecfef);';
      css = `.t{font-size:4rem;color:#fff;text-shadow:3px 3px 0 #00e6e6,-3px -3px 0 #ff00de;letter-spacing:10px;text-transform:uppercase;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'retro':
      bodyStyle = 'background:#1a1a1a;color:#33ff00;';
      css = `.t{font-family:monospace;font-size:4rem;image-rendering:pixelated;}body{background-image:linear-gradient(rgba(18,16,16,0)50%,rgba(0,0,0,0.25)50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06));background-size:100% 4px,6px 100%;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'fire':
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;text-shadow:0 0 10px #ff0,0 0 20px #f00,0 0 40px #f00;animation:f 1s infinite alternate;}@keyframes f{from{text-shadow:0 0 10px #ff0,0 0 20px #f00}to{text-shadow:0 0 20px #ff0,0 0 40px #f00,0 0 60px #f00}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'ice':
      css = `.t{font-size:5rem;font-weight:bold;color:#e0ffff;text-shadow:0 0 10px #0ff,0 0 20px #00f,0 0 40px #00f;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'neon':
      bodyStyle = 'background:#050505;';
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;text-shadow:0 0 5px #fff,0 0 10px #fff,0 0 20px #ff00de,0 0 40px #ff00de,0 0 80px #ff00de;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'shadow':
      css = `.t{font-size:6rem;font-weight:900;color:#333;text-shadow:15px 15px 0 #000;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'blur':
      css = `.t{font-size:5rem;color:#fff;filter:blur(15px);transition:filter 0.5s;}.t:hover{filter:blur(0);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'invisible':
      css = `.t{font-size:5rem;color:#111;user-select:all;}.t::selection{background:#fff;color:#000;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'gradient_bg':
      bodyStyle = 'background:linear-gradient(45deg,#ff0000,#ff7300,#fffb00,#48ff00,#00ffd5,#002bff,#7a00ff,#ff00c8,#ff0000);background-size:400%;animation:r 10s linear infinite;';
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;}@keyframes r{0%{background-position:0%}100%{background-position:400%}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'typing':
      css = `.t{font-size:4rem;color:#fff;border-right:4px solid #fff;white-space:nowrap;overflow:hidden;width:0;animation:typ 3s steps(${safe.length}) forwards,b 0.7s step-end infinite;}@keyframes typ{to{width:100%}}@keyframes b{50%{border-color:transparent}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'bounce':
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach((l,i)=>{const s=document.createElement('span');s.textContent=l;s.style.display='inline-block';s.style.animation=\`b 0.5s ease infinite alternate \${i*0.1}s\`;c.appendChild(s);});document.head.insertAdjacentHTML('beforeend','<style>@keyframes b{to{transform:translateY(-30px)}}</style>');`;
      break;
    case 'wave':
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach((l,i)=>{const s=document.createElement('span');s.textContent=l;s.style.display='inline-block';s.style.animation=\`w 1.5s ease-in-out infinite \${i*0.1}s\`;c.appendChild(s);});document.head.insertAdjacentHTML('beforeend','<style>@keyframes w{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}</style>');`;
      break;
    case 'mirror':
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;position:relative;}.t::after{content:attr(data-t);position:absolute;top:100%;left:0;transform:scaleY(-1);opacity:0.3;filter:blur(2px);}`;
      html = `<div class="t" data-t="${safe}">${safe}</div>`;
      break;
    case 'scramble':
      css = `.t{font-size:4rem;font-weight:bold;color:#0f0;font-family:monospace;}`;
      html = `<div class="t" id="box">${safe}</div>`;
      js = `const el=document.getElementById('box');const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&';let it=setInterval(()=>{el.textContent="${safe}".split('').map((c,i)=>Math.random()>0.7?chars[Math.floor(Math.random()*chars.length)]:"${safe}"[i]).join('');},100);`;
      break;
    case 'ascii':
      bodyStyle = 'background:#000;color:#fff;';
      css = `.t{font-family:monospace;font-size:1.2rem;white-space:pre;line-height:1.2;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'terminal':
      bodyStyle = 'background:#0c0c0c;color:#cccccc;';
      css = `.t{font-family:monospace;font-size:2rem;}`;
      html = `<div class="t">user@vercel:~$ ${safe}</div>`;
      break;
    case 'error':
      bodyStyle = 'background:#008080;';
      css = `.box{background:#c0c0c0;border:2px solid #fff;border-right-color:#404040;border-bottom-color:#404040;padding:2px;width:300px;font-family:sans-serif;font-size:14px;}.title{background:#000080;color:#fff;padding:2px 4px;font-weight:bold;display:flex;justify-content:space-between;}.content{padding:20px;display:flex;align-items:center;gap:15px;}.btn{border:2px solid #fff;border-right-color:#404040;border-bottom-color:#404040;background:#c0c0c0;padding:4px 15px;margin-top:10px;cursor:pointer;}`;
      html = `<div class="box"><div class="title"><span>Error</span><span>X</span></div><div class="content"><div style="color:red;font-size:30px;font-weight:bold;">!</div><div>${safe}</div></div><div style="text-align:center;"><div class="btn">OK</div></div></div>`;
      break;
    case 'loading':
      css = `.t{font-size:3rem;color:#fff;display:flex;gap:10px;}.t span{animation:l 1s infinite ease-in-out;}.t span:nth-child(2){animation-delay:0.2s}.t span:nth-child(3){animation-delay:0.4s}@keyframes l{0%,100%{transform:translateY(0)}50%{transform:translateY(-20px)}}`;
      html = `<div class="t">${safe.split('').map(c=>`<span>${c}</span>`).join('')}</div>`;
      break;
    case 'marquee':
      bodyStyle = 'background:#fff;color:#000;';
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<marquee behavior="scroll" direction="left" scrollamount="15"><div class="t">${safe}</div></marquee>`;
      break;
    case 'vertical':
      css = `.t{font-size:4rem;font-weight:bold;color:#fff;writing-mode:vertical-rl;text-orientation:upright;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'diagonal':
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;transform:rotate(-30deg);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'rainbow_bg':
      css = `.t{font-size:5rem;font-weight:900;color:#000;animation:rb 2s infinite;}@keyframes rb{0%{background:red}16%{background:orange}33%{background:yellow}50%{background:green}66%{background:blue}83%{background:indigo}100%{background:violet}}`;
      html = `<div class="t" style="padding:20px;">${safe}</div>`;
      break;
    case 'strobe':
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;animation:st 0.2s infinite;}@keyframes st{0%{background:#fff;color:#000}50%{background:#000;color:#fff}100%{background:#fff;color:#000}}`;
      html = `<div class="t" style="padding:50px;">${safe}</div>`;
      break;
    case 'blood':
      css = `.t{font-size:6rem;font-weight:900;color:#8a0303;text-shadow:0 5px 10px #ff0000,0 15px 20px #500000;filter:drop-shadow(0 0 5px #ff0000);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'gold':
      css = `.t{font-size:5rem;font-weight:900;background:linear-gradient(to bottom,#cfc09f 22%,#634f2c 24%,#cfc09f 26%,#cfc09f 27%,#ffecb3 40%,#3a2c0f 78%);-webkit-background-clip:text;color:transparent;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'silver':
      css = `.t{font-size:5rem;font-weight:900;background:linear-gradient(to bottom,#e8e8e8 0%,#d0d0d0 50%,#ffffff 51%,#d0d0d0 100%);-webkit-background-clip:text;color:transparent;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'transparent':
      css = `.t{font-size:6rem;font-weight:900;color:transparent;-webkit-text-stroke:2px #fff;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'outline':
      css = `.t{font-size:6rem;font-weight:900;color:transparent;-webkit-text-stroke:3px #00ff00;}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case '3d':
      css = `.t{font-size:6rem;font-weight:900;color:#fff;text-shadow:1px 1px 0 #ccc,2px 2px 0 #ccc,3px 3px 0 #ccc,4px 4px 0 #ccc,5px 5px 0 #ccc,6px 6px 0 #ccc,7px 7px 0 #ccc,8px 8px 0 #ccc,15px 15px 20px rgba(0,0,0,0.5);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'skewed':
      css = `.t{font-size:5rem;font-weight:900;color:#fff;transform:skewX(-20deg);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'stretched':
      css = `.t{font-size:5rem;font-weight:900;color:#fff;transform:scaleX(3);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'compressed':
      css = `.t{font-size:5rem;font-weight:900;color:#fff;transform:scaleX(0.4);}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'random_colors':
      css = `.t{font-size:5rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach(l=>{const s=document.createElement('span');s.textContent=l;s.style.color=\`hsl(\${Math.random()*360},100%,50%)\`;c.appendChild(s);});`;
      break;
    case 'random_size':
      css = `.t{font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach(l=>{const s=document.createElement('span');s.textContent=l;s.style.fontSize=\`\${Math.random()*4+1}rem\`;s.style.margin='0 5px';c.appendChild(s);});`;
      break;
    case 'random_rotation':
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach(l=>{const s=document.createElement('span');s.textContent=l;s.style.display='inline-block';s.style.transform=\`rotate(\${Math.random()*60-30}deg)\`;s.style.margin='0 5px';c.appendChild(s);});`;
      break;
    case 'snake':
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach((l,i)=>{const s=document.createElement('span');s.textContent=l;s.style.display='inline-block';s.style.animation=\`sn 2s ease-in-out infinite \${i*0.15}s\`;c.appendChild(s);});document.head.insertAdjacentHTML('beforeend','<style>@keyframes sn{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-30px) rotate(10deg)}75%{transform:translateY(30px) rotate(-10deg)}}</style>');`;
      break;
    case 'explosion':
      css = `.t{font-size:4rem;font-weight:bold;}`;
      html = `<div class="t" id="box"></div>`;
      js = `const c=document.getElementById('box');"${safe}".split('').forEach((l,i)=>{const s=document.createElement('span');s.textContent=l;s.style.display='inline-block';s.style.animation=\`ex 1.5s ease-out infinite \${i*0.05}s\`;c.appendChild(s);});document.head.insertAdjacentHTML('beforeend','<style>@keyframes ex{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(\${Math.random()*200-100}px,\${Math.random()*200-100}px) scale(0);opacity:0}}</style>');`;
      break;
    case 'void':
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;animation:v 3s linear infinite;}@keyframes v{0%{transform:translateY(-100vh);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(100vh);opacity:0}}`;
      html = `<div class="t">${safe}</div>`;
      break;
    case 'echo':
      css = `.t{font-size:5rem;font-weight:900;color:#fff;position:relative;}.t::before,.t::after{content:attr(data-t);position:absolute;top:0;left:0;}.t::before{color:rgba(255,0,0,0.5);transform:translate(-5px,-5px);}.t::after{color:rgba(0,0,255,0.5);transform:translate(5px,5px);}`;
      html = `<div class="t" data-t="${safe}">${safe}</div>`;
      break;
    case 'default':
    default:
      css = `.t{font-size:5rem;font-weight:bold;color:#fff;}`;
      html = `<div class="t">${safe}</div>`;
      break;
  }

  const finalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${mode}</title>
<style>
${css}
</style>
</head>
<body style="${bodyStyle}">
${html}
<script>
${js}
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(finalHtml);
}