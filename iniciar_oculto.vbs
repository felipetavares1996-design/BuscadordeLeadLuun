Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\felipe\Leads do google para A luum"
WshShell.Run "cmd /c node server.js", 0, False

