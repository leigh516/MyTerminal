import React, { useState, useEffect } from "react";
import introImage from "../assets/SuperTerminal.png";

export const IntroPopup: React.FC = () => {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    // 3초 후 페이드아웃 시작
    const fadeTimer = setTimeout(() => {
      setFading(true);
    }, 3000);

    // 4초 후 컴포넌트 완전히 제거
    const removeTimer = setTimeout(() => {
      setVisible(false);
    }, 3500);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm transition-opacity duration-500 ease-in-out ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="bg-theme-surface border border-theme-border/20 shadow-2xl rounded-2xl p-10 flex flex-col items-center gap-6 max-w-sm text-center transform scale-100 animate-in zoom-in duration-300">
        <div className="w-40 h-40 flex items-center justify-center bg-theme-base rounded-full shadow-inner overflow-hidden border border-theme-border/10">
          <img src={introImage} alt="Super Terminal Logo" className="object-cover w-full h-full" />
        </div>
        
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold text-theme-primary-light tracking-tight">
            Super Terminal
          </h1>
          <div className="w-16 h-1 bg-theme-primary mx-auto rounded-full mt-2 mb-4 opacity-50"></div>
          <p className="text-sm font-medium text-theme-text">만든이 : 이규홍</p>
          <p className="text-xs text-theme-muted">제조사 : (주)누리인프라</p>
        </div>
      </div>
    </div>
  );
};
