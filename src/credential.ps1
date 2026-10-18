param([ValidateSet('set','get','delete')][string]$Action)

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HarnessCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public Int64 LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="CredWriteW", SetLastError=true)]
  static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="CredReadW", SetLastError=true)]
  static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="CredDeleteW", SetLastError=true)]
  static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static void Set(string target, string value) {
    byte[] bytes = Encoding.Unicode.GetBytes(value);
    IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, blob, bytes.Length);
      Credential c = new Credential { Type=1, TargetName=target, CredentialBlobSize=(UInt32)bytes.Length, CredentialBlob=blob, Persist=2, UserName=Environment.UserName };
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(blob); }
  }
  public static string Get(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return "";
    try {
      Credential c = Marshal.PtrToStructure<Credential>(ptr);
      if (c.CredentialBlobSize == 0) return "";
      byte[] bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.Unicode.GetString(bytes);
    } finally { CredFree(ptr); }
  }
  public static void Delete(string target) { CredDelete(target, 1, 0); }
}
'@
Add-Type -TypeDefinition $code
$target = 'PersonalAgentHarness:DeepSeekApiKey'
if ($Action -eq 'set') {
  $value = [Console]::In.ReadToEnd().Trim()
  if (-not $value) { throw 'API key 不能为空' }
  [HarnessCredential]::Set($target, $value)
  Write-Output 'OK'
} elseif ($Action -eq 'get') {
  [Console]::Out.Write([HarnessCredential]::Get($target))
} else {
  [HarnessCredential]::Delete($target)
  Write-Output 'OK'
}
