import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { UploadCloud, Download, Printer, RefreshCw, FileText, Loader2, Info, Layers, CheckCircle2, BookOpen, File as FileIcon, Trash2, Camera, Sparkles, Plus, Image as ImageIcon, Play } from 'lucide-react';

// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure pdfjs worker using standard Vite URL import
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

async function getNonBlankPages(fileBuffer: ArrayBuffer): Promise<number[]> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer).slice() });
  const doc = await loadingTask.promise;
  const nonBlankIndices: number[] = [];
  
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const scale = 0.2;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      nonBlankIndices.push(i - 1);
      continue;
    }
    
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    await page.render({ canvasContext: context, canvas, viewport } as any).promise;
    
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    let nonWhitePixels = 0;
    for (let j = 0; j < data.length; j += 4) {
      if ((data[j] < 240 || data[j+1] < 240 || data[j+2] < 240) && data[j+3] > 10) {
        nonWhitePixels++;
      }
    }
    
    const thresholdPixels = canvas.width * canvas.height * 0.005;
    if (nonWhitePixels > thresholdPixels) {
      nonBlankIndices.push(i - 1);
    }
    
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return nonBlankIndices;
}

async function normalizeImageToBytes(file: File): Promise<{ bytes: Uint8Array; type: 'jpg' | 'png' }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        // 4K UHD Ultra-HD resolution limit (3840px) for professional print-ready export quality
        const MAX_DIM = 3840;
        let w = img.width;
        let h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) {
            h = Math.round((h * MAX_DIM) / w);
            w = MAX_DIM;
          } else {
            w = Math.round((w * MAX_DIM) / h);
            h = MAX_DIM;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        
        const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
        const mimeType = isPng ? 'image/png' : 'image/jpeg';
        
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Could not export image blob'));
            return;
          }
          blob.arrayBuffer().then((buf) => {
            resolve({
              bytes: new Uint8Array(buf),
              type: isPng ? 'png' : 'jpg'
            });
          });
        }, mimeType, 0.98); // 98% quality for pristine 4K print output
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [appMode, setAppMode] = useState<'pdf' | 'album'>('pdf');
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [processedBytes, setProcessedBytes] = useState<Uint8Array | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [marginInches, setMarginInches] = useState(0.5);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  
  // PDF Book settings
  const [viewMode, setViewMode] = useState<'single' | 'book'>('book');
  const [layoutMode, setLayoutMode] = useState<'1up' | '2up' | 'booklet'>('1up');
  const [fillMode, setFillMode] = useState<'fit' | 'stretch'>('fit');
  const [showSeparatorLine, setShowSeparatorLine] = useState(false);
  const [bindingMarginMm, setBindingMarginMm] = useState(0);
  const [isDoubleSided, setIsDoubleSided] = useState(true);
  const [removeBlankPages, setRemoveBlankPages] = useState(true);
  const [removedCount, setRemovedCount] = useState(0);

  // Album XV Años settings
  const [albumImages, setAlbumImages] = useState<{ file: File; previewUrl: string; name: string }[]>([]);
  const [albumOrientation, setAlbumOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [albumPhotosPerPage, setAlbumPhotosPerPage] = useState<1 | 2>(1);

  const processPdf = async (file: File, marginValue: number, layout: '1up' | '2up' | 'booklet', fill: 'fit' | 'stretch', drawSeparator: boolean, bindingMm: number, doubleSided: boolean, removeBlanks: boolean) => {
    setIsProcessing(true);
    setProcessingStatus("Procesando documento PDF en alta calidad...");
    setFileName(file.name);
    setCurrentFile(file);
    try {
      const fileBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(fileBuffer);
      const newPdf = await PDFDocument.create();

      let pageIndices = pdfDoc.getPageIndices();
      const originalDocLength = pageIndices.length;
      
      if (removeBlanks) {
        pageIndices = await getNonBlankPages(fileBuffer);
        if (pageIndices.length === 0) pageIndices = [0];
      }
      
      setRemovedCount(originalDocLength - pageIndices.length);

      if (layout === '1up') {
        const LETTER_WIDTH = 612;
        const LETTER_HEIGHT = 792;
        const MARGIN = marginValue * 72;

        const innerWidth = LETTER_WIDTH - MARGIN * 2;
        const innerHeight = LETTER_HEIGHT - MARGIN * 2;

        const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
        const bindingMarginPoints = bindingMm * (72 / 25.4);

        for (let i = 0; i < copiedPages.length; i++) {
          const page = copiedPages[i];
          const { width, height } = page.getSize();
          
          const isOddPage = (i + 1) % 2 !== 0;
          const isBindingOnLeft = doubleSided ? isOddPage : true;
          
          const adjustedInnerWidth = innerWidth - bindingMarginPoints;
          
          let scaleX = adjustedInnerWidth / width;
          let scaleY = innerHeight / height;
          
          if (fill === 'fit') {
            const minScale = Math.min(scaleX, scaleY);
            scaleX = minScale;
            scaleY = minScale;
          }
          
          const scaledWidth = width * scaleX;
          const scaledHeight = height * scaleY;
          
          let xOffset;
          if (isBindingOnLeft) {
            xOffset = MARGIN + bindingMarginPoints + (adjustedInnerWidth - scaledWidth) / 2;
          } else {
            xOffset = MARGIN + (adjustedInnerWidth - scaledWidth) / 2;
          }
          
          const yOffset = MARGIN + (innerHeight - scaledHeight) / 2;

          page.scaleContent(scaleX, scaleY);
          page.translateContent(xOffset, yOffset);
          page.setSize(LETTER_WIDTH, LETTER_HEIGHT);
          
          newPdf.addPage(page);
        }
      } else {
        const SHEET_WIDTH = 792;
        const SHEET_HEIGHT = 612;
        const HALF_WIDTH = SHEET_WIDTH / 2;
        const MARGIN = marginValue * 72;
        const bindingMarginPoints = bindingMm * (72 / 25.4);
        const innerHeight = SHEET_HEIGHT - MARGIN * 2;
        const adjustedInnerWidth = HALF_WIDTH - MARGIN * 2 - bindingMarginPoints;

        const embeddedPages = await newPdf.embedPdf(pdfDoc, pageIndices);
        
        let pagesForLayout: (any | null)[] = [...embeddedPages];
        
        if (layout === 'booklet') {
          while (pagesForLayout.length % 2 !== 0) {
            pagesForLayout.push(null);
          }
          const bookletPages = [];
          const N = pagesForLayout.length;
          for (let i = 0; i < N / 2; i++) {
            if (i % 2 === 0) {
              bookletPages.push(pagesForLayout[N - 1 - i]);
              bookletPages.push(pagesForLayout[i]);
            } else {
              bookletPages.push(pagesForLayout[i]);
              bookletPages.push(pagesForLayout[N - 1 - i]);
            }
          }
          pagesForLayout = bookletPages;
        }

        for (let i = 0; i < pagesForLayout.length; i += 2) {
          const newPage = newPdf.addPage([SHEET_WIDTH, SHEET_HEIGHT]);
          
          const leftPage = pagesForLayout[i];
          if (leftPage) {
            let scaleXLeft = adjustedInnerWidth / leftPage.width;
            let scaleYLeft = innerHeight / leftPage.height;
            
            if (fill === 'fit') {
              const minScaleL = Math.min(scaleXLeft, scaleYLeft);
              scaleXLeft = minScaleL;
              scaleYLeft = minScaleL;
            }
            
            const scaledWidthLeft = leftPage.width * scaleXLeft;
            const scaledHeightLeft = leftPage.height * scaleYLeft;
            
            const xLeft = MARGIN + (adjustedInnerWidth - scaledWidthLeft) / 2;
            const yLeft = MARGIN + (innerHeight - scaledHeightLeft) / 2;
            
            newPage.drawPage(leftPage, {
              x: xLeft,
              y: yLeft,
              width: scaledWidthLeft,
              height: scaledHeightLeft,
            });
          }

          const rightPage = pagesForLayout[i + 1];
          if (rightPage) {
            let scaleXRight = adjustedInnerWidth / rightPage.width;
            let scaleYRight = innerHeight / rightPage.height;
            
            if (fill === 'fit') {
              const minScaleR = Math.min(scaleXRight, scaleYRight);
              scaleXRight = minScaleR;
              scaleYRight = minScaleR;
            }
            
            const scaledWidthRight = rightPage.width * scaleXRight;
            const scaledHeightRight = rightPage.height * scaleYRight;
            
            const xRight = HALF_WIDTH + MARGIN + bindingMarginPoints + (adjustedInnerWidth - scaledWidthRight) / 2;
            const yRight = MARGIN + (innerHeight - scaledHeightRight) / 2;
            
            newPage.drawPage(rightPage, {
              x: xRight,
              y: yRight,
              width: scaledWidthRight,
              height: scaledHeightRight,
            });
          }

          if (drawSeparator) {
            newPage.drawLine({
              start: { x: HALF_WIDTH, y: 0 },
              end: { x: HALF_WIDTH, y: SHEET_HEIGHT },
              thickness: 1,
              color: rgb(0, 0, 0),
              opacity: 0.5,
            });
          }
        }
      }

      const newPdfBytes = await newPdf.save();
      const bytesForExport = new Uint8Array(newPdfBytes);
      setProcessedBytes(bytesForExport);

      const loadingTask = pdfjsLib.getDocument({ data: newPdfBytes });
      const loadedPdf = await loadingTask.promise;

      const images: string[] = [];
      for (let i = 1; i <= loadedPdf.numPages; i++) {
        const page = await loadedPdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 }); // High-res 2x preview
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, canvas, viewport } as any).promise;
        images.push(canvas.toDataURL('image/png'));
      }

      setPageImages(images);
    } catch (err) {
      console.error("Error processing PDF:", err);
      alert("Hubo un error al procesar el documento. Verifica que sea un PDF válido.");
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const processAlbumPdf = async (
    imagesList: { file: File; previewUrl: string; name: string }[],
    orientation: 'portrait' | 'landscape',
    photosPerPage: 1 | 2,
    marginValue: number
  ) => {
    if (imagesList.length === 0) return;
    setIsProcessing(true);
    setFileName("Album_XV_Anos_4K.pdf");
    try {
      const newPdf = await PDFDocument.create();
      const MARGIN = marginValue * 72;

      if (photosPerPage === 1) {
        const LETTER_W = orientation === 'portrait' ? 612 : 792;
        const LETTER_H = orientation === 'portrait' ? 792 : 612;
        const innerW = LETTER_W - MARGIN * 2;
        const innerH = LETTER_H - MARGIN * 2;

        for (let i = 0; i < imagesList.length; i++) {
          setProcessingStatus(`Procesando foto 4K ${i + 1} de ${imagesList.length}...`);
          await new Promise(r => setTimeout(r, 0));

          const item = imagesList[i];
          const { bytes, type } = await normalizeImageToBytes(item.file);
          const embeddedImg = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
          
          const imgDims = embeddedImg.scale(1);
          const imgAspect = imgDims.width / imgDims.height;
          
          let targetW = innerW;
          let targetH = innerW / imgAspect;
          
          if (targetH > innerH) {
            targetH = innerH;
            targetW = innerH * imgAspect;
          }
          
          const page = newPdf.addPage([LETTER_W, LETTER_H]);
          page.drawRectangle({
            x: 0,
            y: 0,
            width: LETTER_W,
            height: LETTER_H,
            color: rgb(1, 1, 1),
          });

          const x = MARGIN + (innerW - targetW) / 2;
          const y = MARGIN + (innerH - targetH) / 2;
          
          page.drawImage(embeddedImg, {
            x,
            y,
            width: targetW,
            height: targetH,
          });
        }
      } else {
        const SHEET_W = 792;
        const SHEET_H = 612;
        const HALF_W = SHEET_W / 2;
        const innerWidth2 = HALF_W - MARGIN * 1.5;
        const innerHeight2 = SHEET_H - MARGIN * 2;

        for (let i = 0; i < imagesList.length; i += 2) {
          setProcessingStatus(`Procesando par 4K ${Math.floor(i / 2) + 1} de ${Math.ceil(imagesList.length / 2)}...`);
          await new Promise(r => setTimeout(r, 0));

          const page = newPdf.addPage([SHEET_W, SHEET_H]);
          page.drawRectangle({ x: 0, y: 0, width: SHEET_W, height: SHEET_H, color: rgb(1, 1, 1) });

          const leftItem = imagesList[i];
          if (leftItem) {
            const { bytes, type } = await normalizeImageToBytes(leftItem.file);
            const embeddedImg = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
            const imgAspect = embeddedImg.width / embeddedImg.height;

            let targetW = innerWidth2;
            let targetH = innerWidth2 / imgAspect;
            if (targetH > innerHeight2) {
              targetH = innerHeight2;
              targetW = innerHeight2 * imgAspect;
            }
            const x = MARGIN + (innerWidth2 - targetW) / 2;
            const y = MARGIN + (innerHeight2 - targetH) / 2;

            page.drawImage(embeddedImg, { x, y, width: targetW, height: targetH });
          }

          const rightItem = imagesList[i + 1];
          if (rightItem) {
            const { bytes, type } = await normalizeImageToBytes(rightItem.file);
            const embeddedImg = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
            const imgAspect = embeddedImg.width / embeddedImg.height;

            let targetW = innerWidth2;
            let targetH = innerWidth2 / imgAspect;
            if (targetH > innerHeight2) {
              targetH = innerHeight2;
              targetW = innerHeight2 * imgAspect;
            }
            const x = HALF_W + (HALF_W - innerWidth2) / 2 + (innerWidth2 - targetW) / 2;
            const y = MARGIN + (innerHeight2 - targetH) / 2;

            page.drawImage(embeddedImg, { x, y, width: targetW, height: targetH });
          }
        }
      }

      setProcessingStatus("Generando vista previa en alta definición...");
      await new Promise(r => setTimeout(r, 0));

      const newPdfBytes = await newPdf.save();
      const bytesForExport = new Uint8Array(newPdfBytes);
      setProcessedBytes(bytesForExport);

      const loadingTask = pdfjsLib.getDocument({ data: newPdfBytes });
      const loadedPdf = await loadingTask.promise;

      const images: string[] = [];
      for (let i = 1; i <= loadedPdf.numPages; i++) {
        const page = await loadedPdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvasContext: context, canvas, viewport } as any).promise;
        images.push(canvas.toDataURL('image/png'));
      }
      setPageImages(images);
    } catch (err) {
      console.error("Error creating album PDF:", err);
      alert("Hubo un error al generar el álbum de fotos.");
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const onDropPdf = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      processPdf(acceptedFiles[0], marginInches, layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
    }
  }, [marginInches, layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages]);

  const onDropAlbumImages = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const newItems = acceptedFiles.map(file => ({
        file,
        previewUrl: URL.createObjectURL(file),
        name: file.name
      }));
      setAlbumImages(prev => [...prev, ...newItems]);
    }
  }, []);

  const { getRootProps: getPdfRootProps, getInputProps: getPdfInputProps, isDragActive: isPdfDragActive } = useDropzone({
    onDrop: onDropPdf,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false
  } as any);

  const { getRootProps: getAlbumRootProps, getInputProps: getAlbumInputProps, isDragActive: isAlbumDragActive } = useDropzone({
    onDrop: onDropAlbumImages,
    accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp'] },
    multiple: true
  } as any);

  const removeAlbumImage = (index: number) => {
    setAlbumImages(prev => prev.filter((_, i) => i !== index));
  };

  const downloadPdf = () => {
    if (!processedBytes) return;
    try {
      const blob = new Blob([processedBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName ? `Album_4K_${fileName}` : 'album_xv_anos_4k.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (err) {
      console.error("Error al exportar PDF:", err);
      alert("No se pudo descargar el archivo.");
    }
  };

  const handlePrint = () => {
    try {
      window.print();
    } catch (err) {
      console.error(err);
      alert("No se pudo abrir la ventana de impresión automáticamente.");
    }
  };

  const resetState = () => {
    setProcessedBytes(null);
    setPageImages([]);
    setFileName('');
    setCurrentFile(null);
    setAlbumImages([]);
  };

  return (
    <div className="h-screen overflow-hidden print:overflow-visible flex flex-col bg-[#F4F4F5] text-zinc-900 font-sans print:h-auto print:bg-white print:block">
      <style>
        {`
          @page {
            size: ${appMode === 'pdf' && layoutMode !== '1up' ? 'letter landscape' : albumOrientation === 'landscape' && appMode === 'album' && albumPhotosPerPage === 1 ? 'letter landscape' : appMode === 'album' && albumPhotosPerPage === 2 ? 'letter landscape' : 'letter'};
            margin: 0;
          }
        `}
      </style>
      
      {/* Top Navigation */}
      <nav className="no-print bg-white border-b border-zinc-200 px-6 py-3 flex items-center justify-between z-30 shrink-0 shadow-xs">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-black rounded flex items-center justify-center">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-zinc-900 flex items-center gap-2">
              PDF-to-Book & Album 4K Engine
              <span className="text-[10px] font-normal bg-pink-100 text-pink-700 px-2 py-0.5 rounded border border-pink-200 font-bold">4K ULTRA PRINT</span>
            </h1>
          </div>

          <div className="hidden md:flex items-center gap-1.5 bg-zinc-100 p-1 rounded-lg border border-zinc-200 ml-4">
            <button
              onClick={() => { setAppMode('pdf'); resetState(); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${appMode === 'pdf' ? 'bg-white text-zinc-900 shadow-xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'}`}
            >
              📄 PDF a Libro
            </button>
            <button
              onClick={() => { setAppMode('album'); resetState(); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${appMode === 'album' ? 'bg-black text-white shadow-xs font-semibold' : 'text-zinc-600 hover:text-zinc-900'}`}
            >
              <Sparkles className="w-3.5 h-3.5 text-pink-400" />
              👑 Álbum de XV Años
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {pageImages.length > 0 && (
             <button
              onClick={resetState}
              className="px-4 py-2 text-sm font-medium text-zinc-500 bg-white border border-transparent hover:border-zinc-300 rounded-md hover:bg-zinc-50 flex items-center gap-2 transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Nuevo
            </button>
          )}
          <button
            onClick={handlePrint}
            disabled={pageImages.length === 0}
            className="px-4 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-300 rounded-md hover:bg-zinc-50 flex items-center gap-2 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Printer className="w-4 h-4" />
            Imprimir
          </button>
          <button
            onClick={downloadPdf}
            disabled={pageImages.length === 0}
            className="px-4 py-2 text-sm font-medium text-white bg-black border border-black rounded-md hover:bg-zinc-800 flex items-center gap-2 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-4 h-4" />
            Exportar PDF 4K
          </button>
        </div>
      </nav>

      <main className="flex-1 flex overflow-hidden print:overflow-visible print:block">
        {/* Sidebar Configuration */}
        <aside className="no-print w-[320px] bg-white border-r border-zinc-200 p-6 flex flex-col gap-6 shrink-0 overflow-y-auto">
          
          <div className="flex md:hidden flex-col gap-2">
            <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500">Modo de Aplicación</label>
            <div className="flex gap-2">
              <button
                onClick={() => { setAppMode('pdf'); resetState(); }}
                className={`flex-1 py-2 text-xs font-medium rounded border ${appMode === 'pdf' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
              >
                PDF a Libro
              </button>
              <button
                onClick={() => { setAppMode('album'); resetState(); }}
                className={`flex-1 py-2 text-xs font-medium rounded border ${appMode === 'album' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
              >
                Álbum XV Años
              </button>
            </div>
          </div>

          {appMode === 'pdf' ? (
            <>
              <section>
                <div>
                  <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500 block mb-3">Configuración de Página</label>
                  <div className="space-y-4">
                    <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-medium text-zinc-600">Tamaño de Salida</span>
                        <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold">CARTA (US LETTER)</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mb-3">{layoutMode === '1up' ? '8.5 x 11 in (Portrait)' : '11 x 8.5 in (Landscape)'}</p>
                      
                      <div className="flex gap-2">
                        <button 
                          onClick={() => {
                            setLayoutMode('1up');
                            setViewMode('book');
                            if (currentFile) processPdf(currentFile, marginInches, '1up', fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                          }}
                          className={`flex-1 py-1.5 px-1 text-[10px] font-medium rounded border transition-all ${layoutMode === '1up' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                        >
                          1 Pág / Hoja
                        </button>
                        <button 
                          onClick={() => {
                            setLayoutMode('2up');
                            setViewMode('single');
                            if (currentFile) processPdf(currentFile, marginInches, '2up', fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                          }}
                          className={`flex-1 py-1.5 px-1 text-[10px] font-medium rounded border transition-all ${layoutMode === '2up' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                        >
                          2 Pág (Normal)
                        </button>
                        <button 
                          onClick={() => {
                            setLayoutMode('booklet');
                            setViewMode('single');
                            if (currentFile) processPdf(currentFile, marginInches, 'booklet', fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                          }}
                          className={`flex-1 py-1.5 px-1 text-[10px] font-medium rounded border transition-all ${layoutMode === 'booklet' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                        >
                          Folleto (Libro)
                        </button>
                      </div>
                    </div>
                    {(layoutMode === '2up' || layoutMode === 'booklet') && (
                      <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50 mb-4">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-zinc-600">Línea divisoria</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                              type="checkbox" 
                              className="sr-only peer" 
                              checked={showSeparatorLine}
                              onChange={(e) => {
                                setShowSeparatorLine(e.target.checked);
                                if (currentFile) processPdf(currentFile, marginInches, layoutMode, fillMode, e.target.checked, bindingMarginMm, isDoubleSided, removeBlankPages);
                              }}
                            />
                            <div className="w-7 h-4 bg-zinc-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-zinc-900"></div>
                          </label>
                        </div>
                        <p className="text-[10px] text-zinc-400 mt-1">Línea negra para corte/plegado</p>
                      </div>
                    )}
                    <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-medium text-zinc-600">Márgenes de Impresión</span>
                        <span className="text-xs text-zinc-400">{marginInches.toFixed(2)} in</span>
                      </div>
                      <input 
                        type="range" 
                        className="w-full h-1.5 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-black mb-4" 
                        min="0" 
                        max="1" 
                        step="0.05" 
                        value={marginInches} 
                        onChange={(e) => setMarginInches(parseFloat(e.target.value))}
                        onMouseUp={(e) => {
                          if (currentFile) processPdf(currentFile, parseFloat((e.target as HTMLInputElement).value), layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                        }}
                        onTouchEnd={(e) => {
                          if (currentFile) processPdf(currentFile, parseFloat((e.target as HTMLInputElement).value), layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                        }}
                      />

                      <div className="flex justify-between items-center mb-2 pt-3 border-t border-zinc-200/60">
                        <span className="text-xs font-medium text-zinc-600">Engargolado</span>
                        <span className="text-xs text-zinc-400">{bindingMarginMm} mm</span>
                      </div>
                      <input 
                        type="range" 
                        className="w-full h-1.5 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-black mb-4" 
                        min="0" 
                        max="30" 
                        step="1" 
                        value={bindingMarginMm} 
                        onChange={(e) => setBindingMarginMm(parseInt(e.target.value))}
                        onMouseUp={(e) => {
                          if (currentFile) processPdf(currentFile, marginInches, layoutMode, fillMode, showSeparatorLine, parseInt((e.target as HTMLInputElement).value), isDoubleSided, removeBlankPages);
                        }}
                        onTouchEnd={(e) => {
                          if (currentFile) processPdf(currentFile, marginInches, layoutMode, fillMode, showSeparatorLine, parseInt((e.target as HTMLInputElement).value), isDoubleSided, removeBlankPages);
                        }}
                      />

                      <div className="flex items-center justify-between pt-1">
                         <span className="text-xs text-zinc-500">Márgenes Alternos</span>
                         <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                              type="checkbox" 
                              className="sr-only peer" 
                              checked={isDoubleSided}
                              onChange={(e) => {
                                setIsDoubleSided(e.target.checked);
                                if (currentFile) processPdf(currentFile, marginInches, layoutMode, fillMode, showSeparatorLine, bindingMarginMm, e.target.checked, removeBlankPages);
                              }}
                            />
                            <div className="w-7 h-4 bg-zinc-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-zinc-900"></div>
                          </label>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <div>
                  <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500 block mb-3">Escalado de Contenido</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => {
                        setFillMode('fit');
                        if (currentFile) processPdf(currentFile, marginInches, layoutMode, 'fit', showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                      }}
                      className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg border flex items-center justify-center gap-2 transition-all ${fillMode === 'fit' ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs' : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'}`}
                    >
                      Proporcional
                    </button>
                    <button 
                      onClick={() => {
                        setFillMode('stretch');
                        if (currentFile) processPdf(currentFile, marginInches, layoutMode, 'stretch', showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
                      }}
                      className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg border flex items-center justify-center gap-2 transition-all ${fillMode === 'stretch' ? 'bg-zinc-900 text-white border-zinc-900 shadow-xs' : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'}`}
                    >
                      Estirar (Llenar)
                    </button>
                  </div>
                </div>
              </section>

              <section>
                <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Trash2 className="w-4 h-4 text-zinc-500" />
                      <span className="text-xs font-medium text-zinc-600">Eliminar hojas en blanco</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        className="sr-only peer" 
                        checked={removeBlankPages}
                        onChange={(e) => {
                          setRemoveBlankPages(e.target.checked);
                          if (currentFile) processPdf(currentFile, marginInches, layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, e.target.checked);
                        }}
                      />
                      <div className="w-7 h-4 bg-zinc-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-zinc-900"></div>
                    </label>
                  </div>
                  {removedCount > 0 && (
                    <p className="text-[10px] text-green-600 mt-1 font-medium pl-6">
                      Se eliminaron {removedCount} hojas en blanco.
                    </p>
                  )}
                </div>
              </section>
            </>
          ) : (
            <>
              <section>
                <div>
                  <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500 block mb-3">Diseño del Álbum 4K XV Años</label>
                  <div className="space-y-4">
                    <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                      <span className="text-xs font-medium text-zinc-600 block mb-2">Orientación de Página</span>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setAlbumOrientation('portrait')}
                          className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border ${albumOrientation === 'portrait' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                        >
                          Retrato (Vertical)
                        </button>
                        <button 
                          onClick={() => setAlbumOrientation('landscape')}
                          className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border ${albumOrientation === 'landscape' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                        >
                          Paisaje (Horizontal)
                        </button>
                      </div>
                    </div>

                    <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                      <span className="text-xs font-medium text-zinc-600 block mb-2">Fotos por Página</span>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setAlbumPhotosPerPage(1)}
                          className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border ${albumPhotosPerPage === 1 ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                        >
                          1 Foto (Completa)
                        </button>
                        <button 
                          onClick={() => setAlbumPhotosPerPage(2)}
                          className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border ${albumPhotosPerPage === 2 ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                        >
                          2 Fotos (Dúo)
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-400 mt-2">Calidad 4K sin pérdida de proporción ni compresión agresiva.</p>
                    </div>

                    <div className="p-3 border border-zinc-200 rounded-lg bg-zinc-50">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-medium text-zinc-600">Margen del Álbum</span>
                        <span className="text-xs text-zinc-400">{marginInches.toFixed(2)} in</span>
                      </div>
                      <input 
                        type="range" 
                        className="w-full h-1.5 bg-zinc-200 rounded-lg appearance-none cursor-pointer accent-black" 
                        min="0.2" 
                        max="1" 
                        step="0.05" 
                        value={marginInches} 
                        onChange={(e) => setMarginInches(parseFloat(e.target.value))}
                      />
                    </div>
                  </div>
                </div>
              </section>

              {albumImages.length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500">Fotos 4K Cargadas ({albumImages.length})</label>
                    <button 
                      onClick={() => setAlbumImages([])}
                      className="text-[10px] text-red-600 hover:underline"
                    >
                      Limpiar todas
                    </button>
                  </div>

                  <button
                    onClick={() => processAlbumPdf(albumImages, albumOrientation, albumPhotosPerPage, marginInches)}
                    disabled={isProcessing}
                    className="w-full py-2.5 px-4 bg-black text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-colors shadow-xs mb-3 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-white" />}
                    {isProcessing ? processingStatus || "Procesando..." : `🚀 Generar Álbum 4K (${albumImages.length} fotos)`}
                  </button>

                  <div className="max-h-48 overflow-y-auto space-y-2 pr-1 border border-zinc-200 rounded-lg p-2 bg-zinc-50">
                    {albumImages.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-white border border-zinc-200 p-2 rounded-md shadow-2xs">
                        <div className="flex items-center gap-2 truncate">
                          <img src={item.previewUrl} alt="" className="w-8 h-8 object-cover rounded border border-zinc-300 shrink-0" />
                          <span className="text-xs text-zinc-700 truncate">{item.name}</span>
                        </div>
                        <button 
                          onClick={() => removeAlbumImage(idx)}
                          className="text-zinc-400 hover:text-red-600 p-1 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          <section className="mt-auto pt-4">
            <div className="bg-zinc-900 rounded-xl p-4 text-white">
              <p className="text-[10px] text-zinc-400 mb-1 uppercase tracking-wider">Estado del Motor 4K</p>
              <div className="flex items-center justify-between">
                <span className="text-xs">{isProcessing ? processingStatus || "Procesando..." : pageImages.length > 0 ? "Álbum 4K listo" : "Esperando archivos"}</span>
                {isProcessing ? (
                  <Loader2 className="w-3 h-3 text-zinc-400 animate-spin" />
                ) : (
                  <span className={`w-2 h-2 rounded-full ${pageImages.length > 0 ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-zinc-600"}`}></span>
                )}
              </div>
            </div>
          </section>
        </aside>

        {/* Main Content Area */}
        <section className="flex-1 flex flex-col items-center p-8 bg-zinc-100 relative overflow-y-auto print:overflow-visible print:p-0 print:bg-white print:block pb-24">
          
          {pageImages.length === 0 ? (
            /* Upload State */
            <div className="flex-1 w-full flex flex-col items-center justify-center">
               {appMode === 'pdf' ? (
                 <div 
                    className={`w-full max-w-[446px] aspect-[8.5/11] bg-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)] flex flex-col items-center justify-center relative p-8 mx-auto transition-transform
                      ${isPdfDragActive ? 'scale-[1.02]' : 'scale-100'}`}
                 >
                   <div
                     {...getPdfRootProps()}
                     className={`absolute inset-4 rounded-lg flex flex-col items-center justify-center text-center p-8 transition-all border-2 border-dashed
                       ${isPdfDragActive ? 'border-black bg-zinc-50' : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 cursor-pointer'}
                       ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
                     `}
                   >
                     <input {...getPdfInputProps()} />
                     
                     {isProcessing ? (
                       <>
                          <div className="w-16 h-16 bg-zinc-100 rounded-full flex items-center justify-center mb-4 border border-zinc-200">
                            <Loader2 className="w-8 h-8 text-zinc-400 animate-spin" />
                          </div>
                          <h2 className="text-sm font-semibold text-zinc-900 mb-1 animate-pulse">Renderizando PDF 4K...</h2>
                          <p className="text-xs text-zinc-500">{processingStatus || "Mapeando páginas en alta definición"}</p>
                       </>
                     ) : (
                       <>
                          <div className="w-16 h-16 bg-zinc-50 rounded-full flex items-center justify-center mb-4 border border-zinc-100">
                             <UploadCloud className={`w-8 h-8 ${isPdfDragActive ? 'text-black' : 'text-zinc-400'}`} />
                          </div>
                          <h2 className="text-sm font-semibold text-zinc-900 mb-1">
                            {isPdfDragActive ? "Suelta el PDF aquí" : "Arrastra tu PDF aquí"}
                          </h2>
                          <p className="text-xs text-zinc-500 mb-6">O haz clic para explorar tus archivos</p>
                          
                          <div className="flex gap-2">
                            <span className="px-2 py-1 bg-white border border-zinc-200 rounded text-[10px] text-zinc-400 font-mono">PDF 4K</span>
                            <span className="px-2 py-1 bg-white border border-zinc-200 rounded text-[10px] text-zinc-400 font-mono">Print-Ready</span>
                          </div>
                       </>
                     )}
                   </div>
                 </div>
               ) : (
                 <div className="flex flex-col items-center w-full max-w-xl">
                   <div className="text-center mb-6">
                     <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-pink-100 text-pink-800 mb-3">
                       <Sparkles className="w-3.5 h-3.5" /> Edición Especial XV Años (Calidad 4K Ultra Print)
                     </span>
                     <h2 className="text-xl font-bold text-zinc-900 tracking-tight">Álbum de XV Años en Calidad 4K UHD</h2>
                     <p className="text-xs text-zinc-500 mt-1">Sube tus fotos y haz clic en "Generar Álbum 4K" para exportar un archivo optimizado con máxima fidelidad listo para imprenta.</p>
                   </div>

                   <div
                     {...getAlbumRootProps()}
                     className={`w-full bg-white border-2 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center text-center transition-all cursor-pointer shadow-sm
                       ${isAlbumDragActive ? 'border-pink-500 bg-pink-50/50' : 'border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50'}
                     `}
                   >
                     <input {...getAlbumInputProps()} />
                     <div className="w-16 h-16 bg-pink-50 rounded-full flex items-center justify-center mb-4 border border-pink-100 text-pink-600">
                       <Camera className="w-8 h-8" />
                     </div>
                     <h3 className="text-sm font-semibold text-zinc-900 mb-1">
                       {albumImages.length > 0 ? `${albumImages.length} fotos 4K listas para generar` : "Arrastra tus fotos de XV Años aquí"}
                     </h3>
                     <p className="text-xs text-zinc-500 mb-6">Soporta JPG, PNG, WEBP (Resolución Ultra-HD 3840px)</p>
                     
                     <div className="flex gap-3">
                       <button className="px-4 py-2 bg-black text-white text-xs font-medium rounded-lg hover:bg-zinc-800 transition-colors shadow-xs">
                         {albumImages.length > 0 ? "Añadir más fotos" : "Seleccionar Fotos 4K"}
                       </button>

                       {albumImages.length > 0 && (
                         <button 
                           onClick={(e) => {
                             e.stopPropagation();
                             processAlbumPdf(albumImages, albumOrientation, albumPhotosPerPage, marginInches);
                           }}
                           disabled={isProcessing}
                           className="px-5 py-2 bg-pink-600 text-white text-xs font-semibold rounded-lg hover:bg-pink-700 transition-colors shadow-xs flex items-center gap-2"
                         >
                           {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-white" />}
                           {isProcessing ? processingStatus || "Procesando..." : "Generar Álbum 4K Ahora"}
                         </button>
                       )}
                     </div>
                   </div>
                 </div>
               )}
            </div>
          ) : (
            /* Results State */
            <div className="w-full flex flex-col items-center print-container">
               <div className="no-print text-center mb-6 text-sm text-zinc-500 bg-zinc-200/50 px-4 py-2 rounded-full flex items-center gap-2">
                 <CheckCircle2 className="w-4 h-4 text-green-500" />
                 {appMode === 'album' ? `Álbum 4K generado con ${albumImages.length} fotos (${pageImages.length} páginas).` : `Procesado en ${pageImages.length} ${pageImages.length === 1 ? 'página' : 'páginas'}.`} Usa el botón "Imprimir" o "Exportar PDF 4K" arriba.
               </div>
               
               {appMode === 'pdf' && viewMode === 'book' ? (
                  (() => {
                    const rows = [];
                    rows.push(
                      <div key="cover" className="print-row flex justify-center w-full mb-8 drop-shadow-2xl">
                         <div className="book-placeholder w-[8.5in] hidden md:block"></div>
                         <div className="print-page bg-white relative isolate" style={{ width: '8.5in', height: '11in' }}>
                           <img src={pageImages[0]} alt="Page 1" className="w-full h-full object-contain" />
                           <div className="book-spine absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-black/20 to-transparent pointer-events-none"></div>
                         </div>
                      </div>
                    );
                    
                    for (let i = 1; i < pageImages.length; i += 2) {
                      rows.push(
                        <div key={`spread-${i}`} className="print-row flex justify-center w-full mb-8 drop-shadow-2xl">
                          <div className="print-page bg-white relative isolate" style={{ width: '8.5in', height: '11in' }}>
                            <img src={pageImages[i]} alt={`Page ${i + 1}`} className="w-full h-full object-contain" />
                            <div className="book-spine absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-black/30 to-transparent pointer-events-none"></div>
                          </div>
                          {pageImages[i + 1] ? (
                            <div className="print-page bg-white relative isolate border-l border-zinc-200" style={{ width: '8.5in', height: '11in' }}>
                              <img src={pageImages[i + 1]} alt={`Page ${i + 2}`} className="w-full h-full object-contain" />
                              <div className="book-spine absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-black/30 to-transparent pointer-events-none"></div>
                            </div>
                          ) : (
                              <div className="book-placeholder w-[8.5in] bg-zinc-50 hidden md:block border-l border-zinc-200" style={{ height: '11in' }}></div>
                          )}
                        </div>
                      );
                    }
                    return rows;
                  })()
               ) : (
                 pageImages.map((src, index) => (
                   <div 
                     key={index} 
                     className="print-page bg-white shadow-[0_10px_25px_-5px_rgba(0,0,0,0.1),0_8px_10px_-6px_rgba(0,0,0,0.1)] mb-8 relative"
                     style={{
                       width: appMode === 'album' 
                         ? (albumPhotosPerPage === 2 || albumOrientation === 'landscape' ? '11in' : '8.5in') 
                         : (layoutMode === '1up' ? '8.5in' : '11in'),
                       height: appMode === 'album' 
                         ? (albumPhotosPerPage === 2 || albumOrientation === 'landscape' ? '8.5in' : '11in') 
                         : (layoutMode === '1up' ? '11in' : '8.5in'),
                     }}
                   >
                     {appMode === 'pdf' && layoutMode === '2up' && (
                       <div className="book-spine absolute inset-y-0 left-[50%] -translate-x-[50%] w-[1px] bg-zinc-200 pointer-events-none drop-shadow-md"></div>
                     )}
                     <img src={src} alt={`Page ${index + 1}`} className="w-full h-full object-contain" />
                   </div>
                 ))
               )}
               
               <p className="no-print text-[11px] text-zinc-400 mt-4 tracking-wide text-center">VISTA PREVIA 4K UHD • LISTO PARA IMPRENTA Y EXPORTACIÓN</p>
            </div>
          )}

        </section>
      </main>
    </div>
  );
}
