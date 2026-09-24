; RudariFlow NSIS installer hooks (bundle > windows > nsis > installerHooks).

!macro NSIS_HOOK_POSTINSTALL
  ; 0.10 and earlier shipped the CUDA 12 runtime (about 750 MB); 0.11 and
  ; later use CUDA 13, so an update over an older version removes it.
  Delete "$INSTDIR\cudart64_12.dll"
  Delete "$INSTDIR\cublas64_12.dll"
  Delete "$INSTDIR\cublasLt64_12.dll"
!macroend
