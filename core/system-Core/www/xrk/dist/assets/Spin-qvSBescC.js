import{c as g,a as r,f as w,b,d as T,e as B,g as k,o as u,h as m,n as f,i as a,j as z,k as h,l as R,L as V,m as N,p as P,q as $,r as W,s as v,t as _,T as j,v as E,x as I,y as L,z as O}from"./index-jde4TbJD.js";var D=g([g("@keyframes spin-rotate",`
 from {
 transform: rotate(0);
 }
 to {
 transform: rotate(360deg);
 }
 `),r("spin-container",`
 position: relative;
 `,[r("spin-body",`
 position: absolute;
 top: 50%;
 left: 50%;
 transform: translateX(-50%) translateY(-50%);
 `,[w()])]),r("spin-body",`
 display: inline-flex;
 align-items: center;
 justify-content: center;
 flex-direction: column;
 `),r("spin",`
 display: inline-flex;
 height: var(--n-size);
 width: var(--n-size);
 font-size: var(--n-size);
 color: var(--n-color);
 `,[b("rotate",`
 animation: spin-rotate 2s linear infinite;
 `)]),r("spin-description",`
 display: inline-block;
 font-size: var(--n-font-size);
 color: var(--n-text-color);
 transition: color .3s var(--n-bezier);
 margin-top: 8px;
 `),r("spin-content",`
 opacity: 1;
 transition: opacity .3s var(--n-bezier);
 pointer-events: all;
 `,[b("spinning",`
 user-select: none;
 -webkit-user-select: none;
 pointer-events: none;
 opacity: var(--n-opacity-spinning);
 `)])]);const K={small:20,medium:18,large:16},q={...k.props,contentClass:String,contentStyle:[Object,String],description:String,size:{type:[String,Number],default:"medium"},show:{type:Boolean,default:!0},rotate:{type:Boolean,default:!0},spinning:{type:Boolean,validator:()=>!0,default:void 0},delay:Number,...B,strokeWidth:Number};var X=T({name:"Spin",props:q,slots:Object,setup(e){const{mergedClsPrefixRef:t,inlineThemeDisabled:c}=P(e),y=k("Spin","-spin",D,E,e,t),l=v(()=>{const{size:s}=e,{common:{cubicBezierEaseInOut:o},self:p}=y.value,{opacitySpinning:S,color:x,textColor:C}=p;return{"--n-bezier":o,"--n-opacity-spinning":S,"--n-size":typeof s=="number"?I(s):p[L("size",s)],"--n-color":x,"--n-text-color":C}}),n=c?$("spin",v(()=>{const{size:s}=e;return typeof s=="number"?String(s):s[0]}),l,e):void 0,d=O(e,["spinning","show"]),i=_(!1);return W(s=>{let o;if(d.value){const{delay:p}=e;if(p){o=window.setTimeout(()=>{i.value=!0},p),s(()=>{clearTimeout(o)});return}}i.value=d.value}),{mergedClsPrefix:t,active:i,mergedStrokeWidth:v(()=>{const{strokeWidth:s}=e;if(s!==void 0)return s;const{size:o}=e;return K[typeof o=="number"?"medium":o]}),cssVars:c?void 0:l,themeClass:n==null?void 0:n.themeClass,onRender:n==null?void 0:n.onRender}},render(){var d;const{$slots:e,mergedClsPrefix:t,description:c}=this,y=e.icon&&this.rotate,l=(c||e.description)&&(u(),m("div",{class:a(`${t}-spin-description`)},[f(()=>{var i;return c||((i=e.description)==null?void 0:i.call(e))})],2)),n=e.icon?(u(),m("div",{key:1,class:a([`${t}-spin-body`,this.themeClass])},[z("div",{class:a([`${t}-spin`,y&&`${t}-spin--rotate`]),style:h(e.default?"":this.cssVars)},[f(()=>e.icon())],6),f(()=>l)],2)):(u(),m("div",{key:2,class:a([`${t}-spin-body`,this.themeClass])},[(u(),R(V,{clsPrefix:t,style:h(e.default?"":this.cssVars),stroke:this.stroke,"stroke-width":this.mergedStrokeWidth,radius:this.radius,scale:this.scale,class:a(`${t}-spin`)},null,8,["clsPrefix","style","stroke","stroke-width","radius","scale","class"])),f(()=>l)],2));return(d=this.onRender)==null||d.call(this),e.default?(u(),m("div",{key:3,class:a([`${t}-spin-container`,this.themeClass]),style:h(this.cssVars)},[z("div",{class:a([`${t}-spin-content`,this.active&&`${t}-spin-content--spinning`,this.contentClass]),style:h(this.contentStyle)},[f(()=>{var i;return(i=e.default)==null?void 0:i.call(e)})],6),N(j,{name:"fade-in-transition"},{default:()=>this.active?n:null},1024)],6)):n}});export{X as S};
