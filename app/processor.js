class UmbraProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = null;
    this.port.onmessage = (e) => { this.p = e.data; };
    this._init();
  }

  _init() {
    const sr = sampleRate;
    this.sr = sr;
    const tc = t => 1 - Math.exp(-1 / (t * sr));
    this.smCoef = tc(0.02);
    this.glide = tc(0.09);

    this.phA = new Float64Array(6);
    this.phB = new Float64Array(6);
    this.vFreq = new Float64Array(6).fill(110);
    this.vAmp = new Float64Array(6);
    this.pitchPh = Float64Array.from([0,0.13,0.26,0.39,0.52,0.65]);
    this.panPh   = Float64Array.from([0,0.21,0.42,0.63,0.84,0.11]);
    this.pitchR  = [0.031,0.047,0.053,0.067,0.073,0.089];
    this.panR    = [0.013,0.019,0.023,0.029,0.037,0.041];

    this.subPh = 0; this.subFC = 55;
    this.noiseSt = 1234567;

    this.lpV1L=this.lpV2L=this.lpV1R=this.lpV2R=0;
    this.hpV1L=this.hpV2L=this.hpV1R=this.hpV2R=0;
    this.flPh=0; this.tremPh=0;

    this.cutC=1200; this.volC=0; this.drvC=0;
    this.brtC=0.5;  this.morC=0;  this.fade=0;

    this.aStep=0; this.aSC=0; this.aGate=true;
    this.aPh=0;   this.aFreq=0; this.aEnv=0;
    this.aEven=true; this.aPan=1;

    this.sStep=0; this.sSC=0; this.sGain=1; this.sTgt=1;

    const eBufLen = Math.ceil(sr * 4);
    this.eBufL = new Float64Array(eBufLen);
    this.eBufR = new Float64Array(eBufLen);
    this.eWP = 0; this.eLen = eBufLen;
  }

  process(_i, outputs) {
    const outL = outputs[0][0], outR = outputs[0][1];
    const p = this.p;
    if (!outL || !p || !p.voiceFreqs) return true;

    const sr = this.sr;
    const TP = 6.283185307179586;
    const n = Math.min(6, p.activeVoices | 0);
    const vG = 0.8 / Math.sqrt(Math.max(1, n));
    const fadeStep = 1 / Math.max(1, (p.fadeTimeMs / 1000) * sr);

    const hpF = Math.max(20, p.hpCutoffHz || 20);
    const hpG = Math.tan(Math.PI * hpF / sr);
    const hpK = 1.41421356;
    const hpA1 = 1 / (1 + hpG * (hpG + hpK));
    const hpA2 = hpG * hpA1;
    const hpA3 = hpG * hpA2;

    const slSamp = p.slicerOn ? (60 / p.slicerBPM) * p.slicerDiv * sr : 0;
    const arpBase = (p.arpOn && p.arpNotes?.length)
      ? (60 / p.arpBPM) * p.arpDiv * p.arpFine * sr : 0;

    if (p.arpOn && p.arpNotes?.length) {
      this.aStep = this.aStep % p.arpNotes.length;
      if (!this.aFreq) this.aFreq = p.arpNotes[this.aStep];
    }

    const eOn = p.echoOn;
    const eDS  = Math.max(1, Math.min(this.eLen-1, (p.echoTime||0.15)*sr));
    const eFB  = Math.min(0.95, p.echoFeedback||0);
    const eWt  = p.echoWet||0;

    for (let f = 0; f < outL.length; f++) {
      this.cutC += (p.cutoffHz   - this.cutC) * this.smCoef;
      this.volC += (p.volume     - this.volC) * this.smCoef;
      this.drvC += (p.drive      - this.drvC) * this.smCoef;
      this.brtC += (p.brightness - this.brtC) * this.smCoef;
      this.morC += ((p.morphSaw||0) - this.morC) * this.smCoef;

      const ft = p.fadeTarget;
      if (this.fade < ft) this.fade = Math.min(ft, this.fade + fadeStep);
      else if (this.fade > ft) this.fade = Math.max(ft, this.fade - fadeStep);

      // Filter LFO
      const fLFO = Math.sin(TP * this.flPh) * (p.filterLFODepth||0);
      if (!p.hold) { this.flPh += (p.filterLFORate||0.08)/sr; if(this.flPh>=1) this.flPh-=1; }
      const mC = Math.max(40, Math.min(16000, this.cutC * Math.pow(2, fLFO)));
      const g = Math.tan(Math.PI * mC / sr);
      const k = 1/Math.max(0.5, p.resonance||0.8);
      const a1=1/(1+g*(g+k)), a2=g*a1, a3=g*a2;

      // Tremolo
      const trem = 1-(p.tremoloDepth||0)*0.5*(1-Math.cos(TP*this.tremPh));
      if (!p.hold) { this.tremPh += (p.tremoloRate||0.18)/sr; if(this.tremPh>=1) this.tremPh-=1; }

      let sL=0, sR=0;

      // Voices
      for (let i=0; i<n; i++) {
        this.vAmp[i] += (1-this.vAmp[i])*this.smCoef;
        const tF = (p.highLayer && i>=Math.floor(n/2)) ? p.voiceFreqs[i]*2 : p.voiceFreqs[i];
        this.vFreq[i] += (tF-this.vFreq[i])*this.glide;
        const drift = Math.sin(TP*this.pitchPh[i])*((p.pitchDrift||4)/1200);
        if (!p.hold) { this.pitchPh[i]+=this.pitchR[i]/sr; if(this.pitchPh[i]>=1) this.pitchPh[i]-=1; }
        const freq = this.vFreq[i]*Math.pow(2,drift);
        const det  = (p.detuneCents||8)/1200;
        const iA=freq*Math.pow(2,-det*0.5)/sr, iB=freq*Math.pow(2,det*0.5)/sr;
        const w = p.voiceWaves?.[i]||0;
        const oA=this._shp(w,this.phA[i],iA), oB=this._shp(w,this.phB[i],iB);
        const sA=this.morC>0.001?this._shp(2,this.phA[i],iA):0;
        const sB=this.morC>0.001?this._shp(2,this.phB[i],iB):0;
        this.phA[i]+=iA; if(this.phA[i]>=1) this.phA[i]-=1;
        this.phB[i]+=iB; if(this.phB[i]>=1) this.phB[i]-=1;
        const raw=0.5*(oA+oB);
        const sref=Math.sin(TP*this.phA[i]);
        const vBase=sref+(raw-sref)*this.brtC;
        const vOut=vBase+(0.5*(sA+sB)-vBase)*this.morC;
        const plfo=p.mono?0:Math.sin(TP*this.panPh[i])*(p.panDepth||0.4)*0.5;
        if (!p.hold&&!p.mono) { this.panPh[i]+=this.panR[i]/sr; if(this.panPh[i]>=1) this.panPh[i]-=1; }
        const pan=p.mono?0:Math.max(-1,Math.min(1,(p.voicePans?.[i]||0)+plfo));
        const ang=(pan+1)*Math.PI/4;
        const amp=this.vAmp[i]*trem*vG;
        sL+=vOut*amp*Math.cos(ang); sR+=vOut*amp*Math.sin(ang);
      }

      // Sub
      this.subFC += (p.subFreq-this.subFC)*this.glide;
      if (p.hardSync && this.subPh+this.subFC/sr>=1) { this.phA.fill(0); this.phB.fill(0); }
      const sub=Math.sin(TP*this.subPh)*(p.subLevel||0);
      this.subPh+=this.subFC/sr; if(this.subPh>=1) this.subPh-=1;
      sL+=sub; sR+=sub;

      // Arpeggiator
      if (p.arpOn && p.arpNotes?.length) {
        const nc=p.arpNotes.length;
        const sw=Math.max(0,Math.min(0.49,p.arpSwing||0));
        const ss=this.aEven?arpBase*(1+sw):arpBase*(1-sw);
        this.aSC++;
        if (this.aSC>=ss) {
          this.aSC=0; this.aGate=true; this.aEnv=0; this.aEven=!this.aEven;
          if(p.arpPingPong) this.aPan=-this.aPan;
          const pat=p.arpPattern||0;
          if(pat===1) this.aStep=(this.aStep-1+nc)%nc;
          else if(pat===2) this.aStep=(Math.imul(this.aStep|0,6364136)+1)%nc;
          else this.aStep=(this.aStep+1)%nc;
          this.aFreq=p.arpNotes[this.aStep]; this.aPh=0;
        }
        if(this.aSC>=ss*(p.arpGate||0.7)) this.aGate=false;
        if(this.aGate&&this.aFreq>0) {
          this.aEnv=Math.min(1,this.aEnv+1/Math.max(1,(p.arpAttack||0.04)*sr));
          const aI=this.aFreq/sr, aW=p.arpWave??2;
          const aO=this._shp(aW,this.aPh,aI)*(p.arpLevel||0.35)*this.aEnv;
          this.aPh+=aI; if(this.aPh>=1) this.aPh-=1;
          if(p.arpPingPong){
            const pA=(this.aPan*0.55+1)*Math.PI/4;
            sL+=aO*Math.cos(pA)*1.3; sR+=aO*Math.sin(pA)*1.3;
          } else { sL+=aO; sR+=aO; }
        }
      }

      // Noise
      if(p.noiseLevel>0){
        this.noiseSt=(Math.imul(this.noiseSt,1664525)+1013904223)>>>0;
        const nz=(this.noiseSt/2147483648-1)*p.noiseLevel;
        sL+=nz; sR+=p.mono?nz:nz*0.9;
      }

      // LP SVF
      let v3L=sL-this.lpV2L, v1L=a1*this.lpV1L+a2*v3L, v2L=this.lpV2L+a2*this.lpV1L+a3*v3L;
      this.lpV1L=2*v1L-this.lpV1L; this.lpV2L=2*v2L-this.lpV2L;
      let v3R=sR-this.lpV2R, v1R=a1*this.lpV1R+a2*v3R, v2R=this.lpV2R+a2*this.lpV1R+a3*v3R;
      this.lpV1R=2*v1R-this.lpV1R; this.lpV2R=2*v2R-this.lpV2R;
      let lpL=v2L, lpR=v2R;

      // HP SVF
      let h3L=lpL-this.hpV2L, h1L=hpA1*this.hpV1L+hpA2*h3L, h2L=this.hpV2L+hpA2*this.hpV1L+hpA3*h3L;
      this.hpV1L=2*h1L-this.hpV1L; this.hpV2L=2*h2L-this.hpV2L;
      let h3R=lpR-this.hpV2R, h1R=hpA1*this.hpV1R+hpA2*h3R, h2R=this.hpV2R+hpA2*this.hpV1R+hpA3*h3R;
      this.hpV1R=2*h1R-this.hpV1R; this.hpV2R=2*h2R-this.hpV2R;
      let xL=lpL-hpK*h1L-h2L, xR=lpR-hpK*h1R-h2R;

      // Drive
      const dg=1+this.drvC*3;
      xL=Math.tanh(xL*dg); xR=Math.tanh(xR*dg);

      // Saturation
      if(p.saturation>0){
        const sg=1+p.saturation*5, tsg=Math.tanh(sg);
        xL=Math.tanh(xL*sg)/tsg; xR=Math.tanh(xR*sg)/tsg;
      }

      // Echo
      if(eOn){
        const rp=((this.eWP-Math.floor(eDS))+this.eLen)%this.eLen;
        const eL=this.eBufL[rp], eR=this.eBufR[rp];
        this.eBufL[this.eWP]=xL+eL*eFB; this.eBufR[this.eWP]=xR+eR*eFB;
        this.eWP=(this.eWP+1)%this.eLen;
        xL=xL*(1-eWt)+eL*eWt; xR=xR*(1-eWt)+eR*eWt;
      }

      // Master
      const m=this.volC*this.fade*0.7;
      const oL=this._clip(xL*m), oR=this._clip(xR*m);

      // Slicer
      if(p.slicerOn&&slSamp>0){
        this.sSC++;
        if(this.sSC>=slSamp){
          this.sSC=0; this.sStep=(this.sStep+1)&15;
          const bit=(p.slicerPat>>this.sStep)&1;
          this.sTgt=bit===1?1:(1-(p.slicerDepth||0.8));
        }
        this.sGain+=(this.sTgt-this.sGain)*(p.slicerGrain||0.15);
        outL[f]=oL*this.sGain; outR[f]=oR*this.sGain;
      } else { outL[f]=oL; outR[f]=oR; }
    }
    return true;
  }

  _shp(w,ph,inc){
    const TP=6.283185307179586;
    switch(w){
      case 0: return Math.sin(TP*ph);
      case 1: return 2*Math.abs(2*ph-1)-1;
      case 2: return (2*ph-1)-this._pb(ph,inc);
      case 3:{let s=ph<0.5?1:-1; s+=this._pb(ph,inc);
        const p2=ph+0.5>=1?ph-0.5:ph+0.5; s-=this._pb(p2,inc); return s;}
      default: return Math.sin(TP*ph);
    }
  }
  _pb(t,dt){
    if(t<dt){t/=dt;return t+t-t*t-1;}
    if(t>1-dt){t=(t-1)/dt;return t*t+t+t+1;}
    return 0;
  }
  _clip(x){return Math.max(-1,Math.min(1,x*(1-Math.abs(x)/3)));}
}
registerProcessor('umbra-processor',UmbraProcessor);
