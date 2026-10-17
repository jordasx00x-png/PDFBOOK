import React, { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { UploadCloud, Download, Printer, RefreshCw, FileText, Loader2, Info, Layers, CheckCircle2, BookOpen, File as FileIcon, Trash2, Camera, Sparkles, Plus, Image as ImageIcon, Play, AlertCircle, User as UserIcon, LogOut, FolderOpen, Cloud, Bookmark, Mail } from 'lucide-react';
import { auth, googleProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, db, collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, User } from './firebase';


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

async function normalizeImageToBytes(file: File, autoRotate: boolean = false): Promise<{ bytes: Uint8Array; type: 'jpg' | 'png' }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_DIM = 3840;
        const origW = img.width;
        const origH = img.height;
        const shouldRotate = autoRotate && origW > origH;

        let targetW = shouldRotate ? origH : origW;
        let targetH = shouldRotate ? origW : origH;

        if (targetW > MAX_DIM || targetH > MAX_DIM) {
          if (targetW > targetH) {
            targetH = Math.round((targetH * MAX_DIM) / targetW);
            targetW = MAX_DIM;
          } else {
            targetW = Math.round((targetW * MAX_DIM) / targetH);
            targetH = MAX_DIM;
          }
        }

        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        if (shouldRotate) {
          ctx.save();
          ctx.translate(targetW / 2, targetH / 2);
          ctx.rotate(Math.PI / 2);
          ctx.drawImage(img, -targetH / 2, -targetW / 2, targetH, targetW);
          ctx.restore();
        } else {
          ctx.drawImage(img, 0, 0, targetW, targetH);
        }
        
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
        }, mimeType, 0.98);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [skippedLogin, setSkippedLogin] = useState(false);
  const [savedFiles, setSavedFiles] = useState<any[]>([]);
  const [isSavedFilesOpen, setIsSavedFilesOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

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
  const [albumPhotosPerPage, setAlbumPhotosPerPage] = useState<1 | 2 | 4>(1);
  const [autoRotateLandscape, setAutoRotateLandscape] = useState(true);
  const [albumPhotoScale, setAlbumPhotoScale] = useState(1.15);
  const [albumFitMode, setAlbumFitMode] = useState<'fit' | 'fill'>('fit');

  // Email Auth state & handlers
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState('');
  const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, authEmail, authPassword);
      } else {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      }
      setIsEmailModalOpen(false);
      setAuthEmail('');
      setAuthPassword('');
    } catch (err: any) {
      console.error("Auth error:", err);
      setAuthError(err.message || "Error al autenticarse.");
    }
  };

  // Auth observer & fetch saved files
  useEffect(() => {
    getRedirectResult(auth).catch((err) => {
      console.error("Redirect result error:", err);
    });

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        await fetchSavedFiles(currentUser.uid);
      } else {
        setSavedFiles([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const fetchSavedFiles = async (uid: string) => {
    try {
      const q = query(collection(db, `users/${uid}/files`), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const files = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      setSavedFiles(files);
    } catch (err) {
      console.error("Error al obtener archivos guardados:", err);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.warn("Popup sign-in failed, trying redirect:", err);
      try {
        await signInWithRedirect(auth, googleProvider);
      } catch (redirectErr: any) {
        console.error("Error al iniciar sesión con Google:", redirectErr);
        if (redirectErr?.code === 'auth/unauthorized-domain' || redirectErr?.message?.includes('unauthorized-domain')) {
          alert("El dominio de GitHub Pages no está autorizado en Firebase. Para usar Google Auth en GitHub, ve a tu consola de Firebase -> Authentication -> Settings -> Authorized domains y añade tu dominio. Mientras tanto, puedes usar 'Iniciar con Correo y Contraseña'.");
        } else {
          alert("El inicio con Google está restringido en este dominio externo. Por favor, utiliza el botón 'Iniciar con Correo y Contraseña' para guardar tus archivos en la nube de forma segura.");
        }
      }
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setSkippedLogin(false);
    } catch (err) {
      console.error("Error al cerrar sesión:", err);
    }
  };

  const saveFileToCloud = async (name: string, mode: string, imgs: string[], pdfBytes?: Uint8Array) => {
    if (!user) return;
    setIsSaving(true);
    try {
      let pdfBase64 = '';
      if (pdfBytes) {
        // Convert Uint8Array to base64 safely in chunks if needed
        let binary = '';
        const len = pdfBytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(pdfBytes[i]);
        }
        pdfBase64 = btoa(binary);
      }

      // Store metadata and up to first 10 page preview images to stay under Firestore doc size limit
      const payload = {
        userId: user.uid,
        name: name || 'Documento sin título',
        appMode: mode,
        createdAt: new Date().toISOString(),
        pageCount: imgs.length,
        pageImagesPreview: imgs.slice(0, 10), // preview thumbnails
        pdfBase64: pdfBase64.length < 900000 ? pdfBase64 : '' // store if under ~900KB
      };

      await addDoc(collection(db, `users/${user.uid}/files`), payload);
      await fetchSavedFiles(user.uid);
    } catch (err) {
      console.error("Error al guardar archivo en la nube:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteCloudFile = async (fileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    if (!confirm("¿Estás seguro de eliminar este archivo guardado?")) return;
    try {
      await deleteDoc(doc(db, `users/${user.uid}/files`, fileId));
      await fetchSavedFiles(user.uid);
    } catch (err) {
      console.error("Error al eliminar archivo:", err);
    }
  };

  const loadCloudFile = (fileItem: any) => {
    setFileName(fileItem.name);
    setAppMode(fileItem.appMode || 'pdf');
    if (fileItem.pageImagesPreview && fileItem.pageImagesPreview.length > 0) {
      setPageImages(fileItem.pageImagesPreview);
    }
    if (fileItem.pdfBase64) {
      const binaryString = atob(fileItem.pdfBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      setProcessedBytes(bytes);
    }
    setIsSavedFilesOpen(false);
  };

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
      } else if (layout === '2up') {
        const LETTER_WIDTH = 792;
        const LETTER_HEIGHT = 612;
        const MARGIN = marginValue * 72;

        const availableWidth = LETTER_WIDTH - MARGIN * 2;
        const availableHeight = LETTER_HEIGHT - MARGIN * 2;
        const halfWidth = availableWidth / 2;

        const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);

        for (let i = 0; i < copiedPages.length; i += 2) {
          const newPage = newPdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
          
          const leftPage = copiedPages[i];
          const rightPage = copiedPages[i + 1];

          if (leftPage) {
            const { width, height } = leftPage.getSize();
            let scaleX = halfWidth / width;
            let scaleY = availableHeight / height;
            if (fill === 'fit') {
              const minScale = Math.min(scaleX, scaleY);
              scaleX = minScale;
              scaleY = minScale;
            }
            const sW = width * scaleX;
            const sH = height * scaleY;
            const xOff = MARGIN + (halfWidth - sW) / 2;
            const yOff = MARGIN + (availableHeight - sH) / 2;

            leftPage.scaleContent(scaleX, scaleY);
            leftPage.translateContent(xOff, yOff);
            
            const embeddedLeft = await newPdf.embedPage(leftPage);
            newPage.drawPage(embeddedLeft);
          }

          if (rightPage) {
            const { width, height } = rightPage.getSize();
            let scaleX = halfWidth / width;
            let scaleY = availableHeight / height;
            if (fill === 'fit') {
              const minScale = Math.min(scaleX, scaleY);
              scaleX = minScale;
              scaleY = minScale;
            }
            const sW = width * scaleX;
            const sH = height * scaleY;
            const xOff = MARGIN + halfWidth + (halfWidth - sW) / 2;
            const yOff = MARGIN + (availableHeight - sH) / 2;

            rightPage.scaleContent(scaleX, scaleY);
            rightPage.translateContent(xOff, yOff);
            
            const embeddedRight = await newPdf.embedPage(rightPage);
            newPage.drawPage(embeddedRight);
          }

          if (drawSeparator) {
            newPage.drawLine({
              start: { x: LETTER_WIDTH / 2, y: MARGIN },
              end: { x: LETTER_WIDTH / 2, y: LETTER_HEIGHT - MARGIN },
              thickness: 0.75,
              color: rgb(0.8, 0.8, 0.8),
            });
          }
        }
      } else if (layout === 'booklet') {
        const LETTER_WIDTH = 792;
        const LETTER_HEIGHT = 612;
        const MARGIN = marginValue * 72;

        const availableWidth = LETTER_WIDTH - MARGIN * 2;
        const availableHeight = LETTER_HEIGHT - MARGIN * 2;
        const halfWidth = availableWidth / 2;

        const copiedPages = await newPdf.copyPages(pdfDoc, pageIndices);
        
        while (copiedPages.length % 4 !== 0) {
          const blankPage = newPdf.addPage([612, 792]);
          copiedPages.push(blankPage);
        }

        const totalP = copiedPages.length;
        const sheetPairs: [number, number][] = [];
        
        for (let s = 0; s < totalP / 2; s++) {
          if (s % 2 === 0) {
            sheetPairs.push([totalP - 1 - s, s]);
          } else {
            sheetPairs.push([s, totalP - 1 - s]);
          }
        }

        for (const [leftIdx, rightIdx] of sheetPairs) {
          const newPage = newPdf.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
          
          const leftP = copiedPages[leftIdx];
          const rightP = copiedPages[rightIdx];

          if (leftP) {
            const { width, height } = leftP.getSize();
            let scaleX = halfWidth / width;
            let scaleY = availableHeight / height;
            if (fill === 'fit') {
              const minScale = Math.min(scaleX, scaleY);
              scaleX = minScale;
              scaleY = minScale;
            }
            const sW = width * scaleX;
            const sH = height * scaleY;
            const xOff = MARGIN + (halfWidth - sW) / 2;
            const yOff = MARGIN + (availableHeight - sH) / 2;

            leftP.scaleContent(scaleX, scaleY);
            leftP.translateContent(xOff, yOff);
            const embeddedLeft = await newPdf.embedPage(leftP);
            newPage.drawPage(embeddedLeft);
          }

          if (rightP) {
            const { width, height } = rightP.getSize();
            let scaleX = halfWidth / width;
            let scaleY = availableHeight / height;
            if (fill === 'fit') {
              const minScale = Math.min(scaleX, scaleY);
              scaleX = minScale;
              scaleY = minScale;
            }
            const sW = width * scaleX;
            const sH = height * scaleY;
            const xOff = MARGIN + halfWidth + (halfWidth - sW) / 2;
            const yOff = MARGIN + (availableHeight - sH) / 2;

            rightP.scaleContent(scaleX, scaleY);
            rightP.translateContent(xOff, yOff);
            const embeddedRight = await newPdf.embedPage(rightP);
            newPage.drawPage(embeddedRight);
          }

          if (drawSeparator) {
            newPage.drawLine({
              start: { x: LETTER_WIDTH / 2, y: MARGIN },
              end: { x: LETTER_WIDTH / 2, y: LETTER_HEIGHT - MARGIN },
              thickness: 0.75,
              color: rgb(0.8, 0.8, 0.8),
            });
          }
        }
      }

      const pdfBytes = await newPdf.save();
      setProcessedBytes(pdfBytes);

      setProcessingStatus("Generando previsualización 4K UHD...");
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.buffer.slice(0) });
      const renderedDoc = await loadingTask.promise;
      const images: string[] = [];

      for (let i = 1; i <= renderedDoc.numPages; i++) {
        const page = await renderedDoc.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // 2.0 scale for pristine 4K display crispness
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, canvas, viewport } as any).promise;
          images.push(canvas.toDataURL('image/jpeg', 0.95));
        }
      }

      setPageImages(images);
      
      if (user) {
        await saveFileToCloud(file.name, 'pdf', images, pdfBytes);
      }
    } catch (err) {
      console.error("Error al procesar PDF:", err);
      alert("Hubo un error al procesar el archivo PDF.");
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const processAlbumPdf = async (
    imagesList: { file: File; previewUrl: string; name: string }[],
    orientation: 'portrait' | 'landscape',
    photosPerPage: 1 | 2 | 4,
    marginVal: number,
    autoRotate: boolean,
    photoScale: number,
    fitMode: 'fit' | 'fill'
  ) => {
    if (imagesList.length === 0) return;
    setIsProcessing(true);
    setProcessingStatus("Generando Álbum de XV Años en 4K Ultra Print...");
    setFileName("Album_XV_Anos.pdf");

    try {
      const newPdf = await PDFDocument.create();
      
      const isLandscape = orientation === 'landscape' || photosPerPage === 4 || photosPerPage === 2;
      const PAGE_W = isLandscape ? 792 : 612;
      const PAGE_H = isLandscape ? 612 : 792;
      const MARGIN = marginVal * 72;

      const availW = PAGE_W - MARGIN * 2;
      const availH = PAGE_H - MARGIN * 2;

      const itemsPerPage = photosPerPage;

      for (let i = 0; i < imagesList.length; i += itemsPerPage) {
        const page = newPdf.addPage([PAGE_W, PAGE_H]);
        const pageImagesSub = imagesList.slice(i, i + itemsPerPage);

        if (photosPerPage === 1) {
          const imgItem = pageImagesSub[0];
          if (imgItem) {
            const { bytes, type } = await normalizeImageToBytes(imgItem.file, autoRotate);
            const embeddedImage = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
            const dims = embeddedImage.scale(1);

            let scaleX = availW / dims.width;
            let scaleY = availH / dims.height;
            let baseScale = fitMode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
            let finalScale = baseScale * photoScale;

            if (fitMode === 'fit') {
              const maxS = Math.min(availW / dims.width, availH / dims.height) * Math.min(photoScale, 1.25);
              finalScale = Math.min(finalScale, maxS);
            }

            const sW = dims.width * finalScale;
            const sH = dims.height * finalScale;
            const xOff = MARGIN + (availW - sW) / 2;
            const yOff = MARGIN + (availH - sH) / 2;

            page.drawImage(embeddedImage, {
              x: xOff,
              y: yOff,
              width: sW,
              height: sH,
            });
          }
        } else if (photosPerPage === 2) {
          const gutter = 20;
          const cellW = (availW - gutter) / 2;
          const cellH = availH;

          for (let idx = 0; idx < pageImagesSub.length; idx++) {
            const imgItem = pageImagesSub[idx];
            const { bytes, type } = await normalizeImageToBytes(imgItem.file, autoRotate);
            const embeddedImage = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
            const dims = embeddedImage.scale(1);

            const fitScale = Math.min(cellW / dims.width, cellH / dims.height);
            let finalScale = fitScale * Math.min(photoScale, 1.0);

            const sW = dims.width * finalScale;
            const sH = dims.height * finalScale;
            
            const cellX = MARGIN + idx * (cellW + gutter);
            const cellY = MARGIN;

            const xOff = cellX + (cellW - sW) / 2;
            const yOff = cellY + (cellH - sH) / 2;

            page.drawImage(embeddedImage, {
              x: xOff,
              y: yOff,
              width: sW,
              height: sH,
            });
          }

          // Center separator line
          page.drawLine({
            start: { x: PAGE_W / 2, y: MARGIN },
            end: { x: PAGE_W / 2, y: PAGE_H - MARGIN },
            thickness: 0.5,
            color: rgb(0.8, 0.8, 0.8),
          });

        } else {
          // 4 photos (2x2 Grid)
          const gutterX = 20;
          const gutterY = 20;
          const cellW = (availW - gutterX) / 2;
          const cellH = (availH - gutterY) / 2;

          for (let idx = 0; idx < pageImagesSub.length; idx++) {
            const imgItem = pageImagesSub[idx];
            const { bytes, type } = await normalizeImageToBytes(imgItem.file, autoRotate);
            const embeddedImage = type === 'png' ? await newPdf.embedPng(bytes) : await newPdf.embedJpg(bytes);
            const dims = embeddedImage.scale(1);

            const fitScale = Math.min(cellW / dims.width, cellH / dims.height);
            let finalScale = fitScale * Math.min(photoScale, 1.0);

            const sW = dims.width * finalScale;
            const sH = dims.height * finalScale;

            const row = Math.floor(idx / 2); // 0 or 1
            const col = idx % 2; // 0 or 1

            const cellX = MARGIN + col * (cellW + gutterX);
            const cellY = MARGIN + (1 - row) * (cellH + gutterY);

            const xOff = cellX + (cellW - sW) / 2;
            const yOff = cellY + (cellH - sH) / 2;

            page.drawImage(embeddedImage, {
              x: xOff,
              y: yOff,
              width: sW,
              height: sH,
            });
          }

          // Grid cross lines
          page.drawLine({
            start: { x: PAGE_W / 2, y: MARGIN },
            end: { x: PAGE_W / 2, y: PAGE_H - MARGIN },
            thickness: 0.5,
            color: rgb(0.85, 0.85, 0.85),
          });
          page.drawLine({
            start: { x: MARGIN, y: PAGE_H / 2 },
            end: { x: PAGE_W - MARGIN, y: PAGE_H / 2 },
            thickness: 0.5,
            color: rgb(0.85, 0.85, 0.85),
          });
        }
      }

      const pdfBytes = await newPdf.save();
      setProcessedBytes(pdfBytes);

      setProcessingStatus("Generando previsualización 4K del álbum...");
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.buffer.slice(0) });
      const renderedDoc = await loadingTask.promise;
      const images: string[] = [];

      for (let i = 1; i <= renderedDoc.numPages; i++) {
        const page = await renderedDoc.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, canvas, viewport } as any).promise;
          images.push(canvas.toDataURL('image/jpeg', 0.95));
        }
      }

      setPageImages(images);

      if (user) {
        await saveFileToCloud("Álbum de XV Años 4K", 'album', images, pdfBytes);
      }
    } catch (err) {
      console.error("Error al generar álbum:", err);
      alert("Hubo un error al generar el álbum de XV Años.");
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const { getRootProps: getPdfRootProps, getInputProps: getPdfInputProps, isDragActive: isPdfDragActive } = useDropzone({
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    onDrop: (acceptedFiles) => {
      if (acceptedFiles.length > 0) {
        processPdf(acceptedFiles[0] as File, marginInches, layoutMode, fillMode, showSeparatorLine, bindingMarginMm, isDoubleSided, removeBlankPages);
      }
    }
  } as any);

  const { getRootProps: getAlbumRootProps, getInputProps: getAlbumInputProps, isDragActive: isAlbumDragActive } = useDropzone({
    accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] },
    onDrop: (acceptedFiles) => {
      const newItems = acceptedFiles.map(file => ({
        file,
        previewUrl: URL.createObjectURL(file),
        name: file.name
      }));
      setAlbumImages(prev => [...prev, ...newItems]);
    }
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
          <button
            onClick={() => setSkippedLogin(false)}
            className="w-8 h-8 bg-black rounded flex items-center justify-center hover:bg-zinc-800 transition-colors"
            title="Ir a la página de inicio"
          >
            <Layers className="w-5 h-5 text-white" />
          </button>
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
          {/* Google Auth & Saved Files */}
          {user ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsSavedFilesOpen(true)}
                className="px-3 py-1.5 text-xs font-medium bg-zinc-100 border border-zinc-200 rounded-md hover:bg-zinc-200 flex items-center gap-1.5 transition-colors"
                title="Mis archivos guardados en la nube"
              >
                <FolderOpen className="w-3.5 h-3.5 text-zinc-600" />
                <span className="hidden sm:inline">Archivos Anteriores</span>
                <span className="bg-black text-white text-[10px] px-1.5 py-0.2 rounded-full font-bold ml-0.5">
                  {savedFiles.length}
                </span>
              </button>

              <div className="flex items-center gap-2 pl-2 border-l border-zinc-200">
                {user.photoURL ? (
                  <img src={user.photoURL} alt={user.displayName || 'Usuario'} className="w-7 h-7 rounded-full border border-zinc-300" />
                ) : (
                  <div className="w-7 h-7 bg-zinc-200 rounded-full flex items-center justify-center text-xs font-bold">
                    {user.email?.[0].toUpperCase()}
                  </div>
                )}
                <button
                  onClick={handleLogout}
                  className="p-1.5 text-zinc-500 hover:text-red-600 rounded hover:bg-zinc-100 transition-colors"
                  title="Cerrar sesión"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleGoogleLogin}
              className="px-4 py-1.5 text-xs font-semibold text-white bg-black hover:bg-zinc-800 rounded-md flex items-center gap-2 shadow-xs transition-all"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              Iniciar sesión con Google
            </button>
          )}

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

      {/* Saved Files Modal / Drawer */}
      {isSavedFilesOpen && (
        <div className="no-print fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-xl w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cloud className="w-5 h-5 text-zinc-900" />
                <h2 className="text-base font-bold text-zinc-900">Mis Archivos Anteriores en la Nube</h2>
              </div>
              <button 
                onClick={() => setIsSavedFilesOpen(false)}
                className="text-zinc-400 hover:text-zinc-700 text-sm font-bold px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto flex-1 space-y-3">
              {savedFiles.length === 0 ? (
                <div className="text-center py-12 text-zinc-400">
                  <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-40" />
                  <p className="text-sm font-medium">No tienes archivos guardados todavía.</p>
                  <p className="text-xs text-zinc-400 mt-1">Los documentos y álbumes que proceses se guardarán automáticamente al iniciar sesión.</p>
                </div>
              ) : (
                savedFiles.map((file) => (
                  <div 
                    key={file.id}
                    onClick={() => loadCloudFile(file)}
                    className="p-4 rounded-xl border border-zinc-200 hover:border-black bg-zinc-50 hover:bg-white transition-all cursor-pointer flex items-center justify-between group"
                  >
                    <div className="flex items-center gap-3.5">
                      <div className="w-10 h-10 bg-white border border-zinc-200 rounded-lg flex items-center justify-center text-zinc-700 shadow-xs">
                        {file.appMode === 'album' ? <Sparkles className="w-5 h-5 text-pink-600" /> : <FileText className="w-5 h-5 text-zinc-800" />}
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-zinc-900 group-hover:underline">{file.name}</h4>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
                          <span className="uppercase text-[10px] bg-zinc-200 text-zinc-700 px-1.5 py-0.5 rounded font-mono">{file.appMode || 'pdf'}</span>
                          <span>•</span>
                          <span>{file.pageCount || 0} páginas</span>
                          <span>•</span>
                          <span>{new Date(file.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => deleteCloudFile(file.id, e)}
                        className="p-2 text-zinc-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                        title="Eliminar archivo"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            <div className="px-6 py-3 border-t border-zinc-200 bg-zinc-50 text-right">
              <button
                onClick={() => setIsSavedFilesOpen(false)}
                className="px-4 py-2 bg-black text-white text-xs font-semibold rounded-lg hover:bg-zinc-800 transition-colors"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

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
                          onClick={() => setLayoutMode('1up')}
                          className={`flex-1 py-1.5 text-xs font-medium rounded border transition-all ${layoutMode === '1up' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-100'}`}
                        >
                          1 Página / Hoja
                        </button>
                        <button
                          onClick={() => setLayoutMode('2up')}
                          className={`flex-1 py-1.5 text-xs font-medium rounded border transition-all ${layoutMode === '2up' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-100'}`}
                        >
                          2 Páginas / Hoja
                        </button>
                      </div>

                      <div className="mt-2">
                        <button
                          onClick={() => setLayoutMode('booklet')}
                          className={`w-full py-1.5 text-xs font-medium rounded border transition-all ${layoutMode === 'booklet' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-100'}`}
                        >
                          📖 Modo Cuadernillo (Imposición)
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-zinc-700 block mb-1.5">Margen de Página ({marginInches} in)</label>
                      <input
                        type="range"
                        min="0"
                        max="1.5"
                        step="0.1"
                        value={marginInches}
                        onChange={(e) => setMarginInches(parseFloat(e.target.value))}
                        className="w-full accent-black cursor-pointer"
                      />
                    </div>

                    {layoutMode === '1up' && (
                      <div>
                        <label className="text-xs font-medium text-zinc-700 block mb-1.5">Margen de Encuadernación ({bindingMarginMm} mm)</label>
                        <input
                          type="range"
                          min="0"
                          max="20"
                          step="1"
                          value={bindingMarginMm}
                          onChange={(e) => setBindingMarginMm(parseInt(e.target.value))}
                          className="w-full accent-black cursor-pointer"
                        />
                        <span className="text-[10px] text-zinc-400 mt-1 block">Añade espacio extra alternado para anillado o lomo.</span>
                      </div>
                    )}

                    {layoutMode !== '1up' && (
                      <div className="flex items-center justify-between pt-2">
                        <span className="text-xs font-medium text-zinc-700">Línea Divisoria Central</span>
                        <input
                          type="checkbox"
                          checked={showSeparatorLine}
                          onChange={(e) => setShowSeparatorLine(e.target.checked)}
                          className="w-4 h-4 accent-black rounded cursor-pointer"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs font-medium text-zinc-700">Eliminar Páginas en Blanco</span>
                      <input
                        type="checkbox"
                        checked={removeBlankPages}
                        onChange={(e) => setRemoveBlankPages(e.target.checked)}
                        className="w-4 h-4 accent-black rounded cursor-pointer"
                      />
                    </div>
                    {removeBlankPages && removedCount > 0 && (
                      <span className="text-[10px] text-green-600 block">Se han omitido {removedCount} páginas en blanco automáticamente.</span>
                    )}
                  </div>
                </div>
              </section>

              {pageImages.length > 0 && (
                <section className="pt-4 border-t border-zinc-200">
                  <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500 block mb-3">Vista Previa Libro</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setViewMode('book')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded border ${viewMode === 'book' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                    >
                      Modo Libro
                    </button>
                    <button
                      onClick={() => setViewMode('single')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded border ${viewMode === 'single' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200'}`}
                    >
                      Lista Simple
                    </button>
                  </div>
                </section>
              )}
            </>
          ) : (
            <>
              <section className="space-y-4">
                <label className="text-[11px] uppercase tracking-widest font-bold text-zinc-500 block">Configuración Álbum XV Años</label>
                
                <div>
                  <label className="text-xs font-medium text-zinc-700 block mb-1.5">Orientación del Álbum</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setAlbumOrientation('portrait')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded border ${albumOrientation === 'portrait' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                    >
                      Vertical (Portrait)
                    </button>
                    <button
                      onClick={() => setAlbumOrientation('landscape')}
                      className={`flex-1 py-1.5 text-xs font-medium rounded border ${albumOrientation === 'landscape' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                    >
                      Horizontal (Landscape)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-700 block mb-1.5">Fotos por Página</label>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      onClick={() => setAlbumPhotosPerPage(1)}
                      className={`py-1.5 px-1 text-[11px] font-medium rounded border ${albumPhotosPerPage === 1 ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                    >
                      1 Foto
                    </button>
                    <button
                      onClick={() => setAlbumPhotosPerPage(2)}
                      className={`py-1.5 px-1 text-[11px] font-medium rounded border ${albumPhotosPerPage === 2 ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                    >
                      2 Fotos
                    </button>
                    <button
                      onClick={() => setAlbumPhotosPerPage(4)}
                      className={`py-1.5 px-1 text-[11px] font-medium rounded border ${albumPhotosPerPage === 4 ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                    >
                      4 Fotos (Grid)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-700 block mb-1.5">Margen ({marginInches} in)</label>
                  <input
                    type="range"
                    min="0"
                    max="1.5"
                    step="0.1"
                    value={marginInches}
                    onChange={(e) => setMarginInches(parseFloat(e.target.value))}
                    className="w-full accent-black cursor-pointer"
                  />
                </div>

                {/* New Section for Photo Scaling and Auto-Rotation */}
                <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg space-y-3">
                  <span className="text-xs font-bold text-zinc-800 block">Tamaño y Orientación de Fotos</span>
                  
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-600">Voltear horizontales (Auto)</span>
                    <input
                      type="checkbox"
                      checked={autoRotateLandscape}
                      onChange={(e) => setAutoRotateLandscape(e.target.checked)}
                      className="w-4 h-4 accent-black rounded cursor-pointer"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs text-zinc-600">Tamaño / Zoom de Foto</span>
                      <span className="text-[10px] font-mono bg-zinc-200 px-1.5 py-0.5 rounded text-zinc-700">{Math.round(albumPhotoScale * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.8"
                      max="1.5"
                      step="0.05"
                      value={albumPhotoScale}
                      onChange={(e) => setAlbumPhotoScale(parseFloat(e.target.value))}
                      className="w-full accent-black cursor-pointer"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-zinc-600 block mb-1">Modo de Ajuste</label>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setAlbumFitMode('fit')}
                        className={`flex-1 py-1 text-[11px] font-medium rounded border ${albumFitMode === 'fit' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                      >
                        Ajustar (Fit)
                      </button>
                      <button
                        onClick={() => setAlbumFitMode('fill')}
                        className={`flex-1 py-1 text-[11px] font-medium rounded border ${albumFitMode === 'fill' ? 'bg-black text-white border-black' : 'bg-white text-zinc-700 border-zinc-200'}`}
                      >
                        Llenar (Fill)
                      </button>
                    </div>
                  </div>
                </div>

                {albumImages.length > 0 && (
                  <div className="pt-4 border-t border-zinc-200">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs font-bold text-zinc-700">Fotos Seleccionadas ({albumImages.length})</span>
                      <button onClick={() => setAlbumImages([])} className="text-[11px] text-red-600 hover:underline">Borrar todas</button>
                    </div>
                    <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                      {albumImages.map((img, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs">
                          <div className="flex items-center gap-2 truncate">
                            <img src={img.previewUrl} alt={img.name} className="w-8 h-8 object-cover rounded" />
                            <span className="truncate max-w-[140px] text-zinc-700">{img.name}</span>
                          </div>
                          <button onClick={() => removeAlbumImage(idx)} className="text-zinc-400 hover:text-red-600 p-1">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => processAlbumPdf(albumImages, albumOrientation, albumPhotosPerPage, marginInches, autoRotateLandscape, albumPhotoScale, albumFitMode)}
                      disabled={isProcessing}
                      className="w-full mt-4 py-2.5 bg-pink-600 text-white font-semibold text-xs rounded-lg hover:bg-pink-700 transition-colors shadow-xs flex items-center justify-center gap-2"
                    >
                      {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-white" />}
                      {isProcessing ? processingStatus || "Procesando..." : "Generar Álbum 4K Ahora"}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
          
          <div className="mt-auto pt-4 border-t border-zinc-200">
            <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-200 flex items-start gap-2.5">
              <Info className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                {user ? `Sesión iniciada como ${user.email}. Tus documentos se sincronizan automáticamente.` : 'Inicia sesión con Google para guardar tus archivos anteriores en la nube.'}
              </p>
            </div>
          </div>

        </aside>

        {/* Main Preview Area */}
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
                             processAlbumPdf(albumImages, albumOrientation, albumPhotosPerPage, marginInches, autoRotateLandscape, albumPhotoScale, albumFitMode);
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
