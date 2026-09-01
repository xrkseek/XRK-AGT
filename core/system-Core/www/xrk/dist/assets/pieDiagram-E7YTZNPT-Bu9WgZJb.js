import{p as rt}from"./chunk-JWPE2WC7-BX2ecYhZ.js";import{ab as b,a3 as B,b3 as nt,g as it,s as ot,a as st,b as lt,o as ct,n as ut,_ as d,l as G,c as gt,A as dt,D as pt,L as ht,d as ft,p as mt,B as vt}from"./ChatView-DJvBYaaW.js";import{p as xt}from"./cynefin-OW5HDTMX-CzkIxMVt.js";import{d as J}from"./arc-hCuMMhej.js";import{o as St}from"./ordinal-Cboi1Yqb.js";import"./index-BVvyQqun.js";import"./useListPaneWidth-C2_zVzv3.js";import"./client-DWBGkzSv.js";import"./Spin-D_hGNulw.js";import"./init-Gi6I4Gst.js";function yt(t,n){return n<t?-1:n>t?1:n>=t?0:NaN}function wt(t){return t}function At(){var t=wt,n=yt,y=null,T=b(0),l=b(B),p=b(0);function i(e){var r,s=(e=nt(e)).length,h,w,$=0,f=new Array(s),o=new Array(s),D=+T.apply(this,arguments),E=Math.min(B,Math.max(-B,l.apply(this,arguments)-D)),k,R=Math.min(Math.abs(E)/s,p.apply(this,arguments)),u=R*(E<0?-1:1),A;for(r=0;r<s;++r)(A=o[f[r]=r]=+t(e[r],r,e))>0&&($+=A);for(n!=null?f.sort(function(M,m){return n(o[M],o[m])}):y!=null&&f.sort(function(M,m){return y(e[M],e[m])}),r=0,w=$?(E-s*u)/$:0;r<s;++r,D=k)h=f[r],A=o[h],k=D+(A>0?A*w:0)+u,o[h]={data:e[h],index:r,value:A,startAngle:D,endAngle:k,padAngle:R};return o}return i.value=function(e){return arguments.length?(t=typeof e=="function"?e:b(+e),i):t},i.sortValues=function(e){return arguments.length?(n=e,y=null,i):n},i.sort=function(e){return arguments.length?(y=e,n=null,i):y},i.startAngle=function(e){return arguments.length?(T=typeof e=="function"?e:b(+e),i):T},i.endAngle=function(e){return arguments.length?(l=typeof e=="function"?e:b(+e),i):l},i.padAngle=function(e){return arguments.length?(p=typeof e=="function"?e:b(+e),i):p},i}var Ct=vt.pie,I={sections:new Map,showData:!1},F=I.sections,V=I.showData,$t=structuredClone(Ct),Dt=d(()=>structuredClone($t),"getConfig"),bt=d(()=>{F=new Map,V=I.showData,mt()},"clear"),Tt=d(({label:t,value:n})=>{if(n<0)throw new Error(`"${t}" has invalid value: ${n}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);F.has(t)||(F.set(t,n),G.debug(`added new section: ${t}, with value: ${n}`))},"addSection"),kt=d(()=>F,"getSections"),zt=d(t=>{V=t},"setShowData"),Et=d(()=>V,"getShowData"),K={getConfig:Dt,clear:bt,setDiagramTitle:ut,getDiagramTitle:ct,setAccTitle:lt,getAccTitle:st,setAccDescription:ot,getAccDescription:it,addSection:Tt,getSections:kt,setShowData:zt,getShowData:Et},Mt=d((t,n)=>{rt(t,n),n.setShowData(t.showData),t.sections.map(n.addSection)},"populateDb"),Lt={parse:d(async t=>{const n=await xt("pie",t);G.debug(n),Mt(n,K)},"parse")},Rt=d(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),Wt=Rt,_t=d(t=>{const n=[...t.values()].reduce((l,p)=>l+p,0),y=[...t.entries()].map(([l,p])=>({label:l,value:p})).filter(l=>l.value/n*100>=1);return At().value(l=>l.value).sort(null)(y)},"createPieArcs"),Ft=d((t,n,y,T)=>{var q;G.debug(`rendering pie chart
`+t);const l=T.db,p=gt(),i=dt(l.getConfig(),p.pie),e=40,r=18,s=4,h=450,w=h,$=pt(n),f=$.append("g");f.attr("transform","translate("+w/2+","+h/2+")");const{themeVariables:o}=p;let[D]=ht(o.pieOuterStrokeWidth);D??(D=2);const E=i.legendPosition,k=i.textPosition,R=i.donutHole>0&&i.donutHole<=.9?i.donutHole:0,u=Math.min(w,h)/2-e,A=J().innerRadius(R*u).outerRadius(u),M=J().innerRadius(u*k).outerRadius(u*k),m=f.append("g");m.append("circle").attr("cx",0).attr("cy",0).attr("r",u+D/2).attr("class","pieOuterCircle");const W=l.getSections(),Q=_t(W),Y=[o.pie1,o.pie2,o.pie3,o.pie4,o.pie5,o.pie6,o.pie7,o.pie8,o.pie9,o.pie10,o.pie11,o.pie12];let H=0;W.forEach(a=>{H+=a});const U=Q.filter(a=>(a.data.value/H*100).toFixed(0)!=="0"),N=St(Y).domain([...W.keys()]);m.selectAll("mySlices").data(U).enter().append("path").attr("d",A).attr("fill",a=>N(a.data.label)).attr("class",a=>{let c="pieCircle";return i.highlightSlice==="hover"?c+=" highlightedOnHover":i.highlightSlice===a.data.label&&(c+=" highlighted"),c}),m.selectAll("mySlices").data(U).enter().append("text").text(a=>(a.data.value/H*100).toFixed(0)+"%").attr("transform",a=>"translate("+M.centroid(a)+")").style("text-anchor","middle").attr("class","slice");const tt=f.append("text").text(l.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),L=[...W.entries()].map(([a,c])=>({label:a,value:c})),C=f.selectAll(".legend").data(L).enter().append("g").attr("class","legend");C.append("rect").attr("width",r).attr("height",r).style("fill",a=>N(a.label)).style("stroke",a=>N(a.label)),C.append("text").attr("x",r+s).attr("y",r-s).text(a=>l.getShowData()?`${a.label} [${a.value}]`:a.label);const z=Math.max(...C.selectAll("text").nodes().map(a=>(a==null?void 0:a.getBoundingClientRect().width)??0));let _=h,O=w+e;const g=r+s,P=L.length*g;switch(E){case"center":C.attr("transform",(a,c)=>{const v=g*L.length/2,x=-z/2-(r+s),S=c*g-v;return"translate("+x+","+S+")"});break;case"top":_+=P,C.attr("transform",(a,c)=>{const v=u,x=-z/2-(r+s),S=c*g-v;return`translate(${x}, ${S})`}),m.attr("transform",()=>`translate(0, ${P+g})`);break;case"bottom":_+=P,C.attr("transform",(a,c)=>{const v=-u-g,x=-z/2-(r+s),S=c*g-v;return"translate("+x+","+S+")"});break;case"left":O+=r+s+z,C.attr("transform",(a,c)=>{const v=g*L.length/2,x=-u-(r+s),S=c*g-v;return"translate("+x+","+S+")"}),m.attr("transform",()=>`translate(${z+r+s}, 0)`);break;case"right":default:O+=r+s+z,C.attr("transform",(a,c)=>{const v=g*L.length/2,x=12*r,S=c*g-v;return"translate("+x+","+S+")"});break}const j=((q=tt.node())==null?void 0:q.getBoundingClientRect().width)??0,et=w/2-j/2,at=w/2+j/2,X=Math.min(0,et),Z=Math.max(O,at)-X;$.attr("viewBox",`${X} 0 ${Z} ${_}`),ft($,_,Z,i.useMaxWidth)},"draw"),Ht={draw:Ft},qt={parser:Lt,db:K,renderer:Ht,styles:Wt};export{qt as diagram};
