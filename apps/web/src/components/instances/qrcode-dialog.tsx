"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QrCode, Loader2 } from "lucide-react";

interface QrCodeDialogProps {
  instanceId: string;
}

export function QrCodeDialog({ instanceId }: QrCodeDialogProps) {
  const [open, setOpen] = useState(false);
  const [qrData, setQrData] = useState<{ base64?: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    const fetchQr = async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`/instances/${instanceId}/qrcode`);
        setQrData(data);
      } catch {
        setQrData(null);
      }
      setLoading(false);
    };

    fetchQr();

    // Refresh QR every 20 seconds
    const interval = setInterval(fetchQr, 20_000);
    return () => clearInterval(interval);
  }, [open, instanceId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <QrCode className="mr-2 h-4 w-4" />
        Conectar via QR Code
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Escanear QR Code</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[300px] items-center justify-center">
          {loading ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          ) : qrData?.base64 ? (
            <img
              src={`data:image/png;base64,${qrData.base64}`}
              alt="QR Code"
              className="h-64 w-64"
            />
          ) : qrData?.code ? (
            <img
              src={`data:image/png;base64,${qrData.code}`}
              alt="QR Code"
              className="h-64 w-64"
            />
          ) : (
            <p className="text-muted-foreground">
              Instancia ja conectada ou QR code indisponivel
            </p>
          )}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          O QR Code atualiza automaticamente a cada 20 segundos
        </p>
      </DialogContent>
    </Dialog>
  );
}
