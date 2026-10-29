// Samostalni pokretač: jedna izvršna datoteka s ugrađenom igrom. Poslužuje stranicu na
// 127.0.0.1 (preglednik daje mikrofon samo sigurnom kontekstu, a localhost to jest)
// i otvara je u zadanom pregledniku. Bez instalacije: dvoklik na .exe.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
)

//go:embed index.html css js
var site embed.FS

// Stalni port da postavke u pregledniku (localStorage je vezan uz port) prežive ponovno pokretanje.
const defaultPort = 47811

func main() {
	port := flag.Int("port", defaultPort, "port na 127.0.0.1")
	noBrowser := flag.Bool("no-browser", false, "ne otvaraj preglednik")
	flag.Parse()

	// Windows uzima MIME tipove iz registra, gdje .js zna biti text/plain, a onda
	// preglednik odbije učitati ES module. Zato ih postavljamo izričito.
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	mime.AddExtensionType(".css", "text/css; charset=utf-8")
	mime.AddExtensionType(".html", "text/html; charset=utf-8")

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		// Port je zauzet, najčešće jer igra već radi; uzmi bilo koji slobodan.
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fail(err)
		}
		fmt.Printf("Port %d je zauzet, koristim drugi (postavke iz prošlog pokretanja neće se vidjeti).\n", *port)
	}
	url := fmt.Sprintf("http://%s/", ln.Addr().String())

	files, _ := fs.Sub(site, ".")
	handler := http.FileServer(http.FS(files))
	fmt.Println("Potapanje brodova preko PSK")
	fmt.Println("Igra radi na", url)
	fmt.Println("Zatvori ovaj prozor za kraj.")
	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Println("Otvori adresu ručno u pregledniku (Edge ili Chrome).")
		}
	}
	fail(http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		handler.ServeHTTP(w, r)
	})))
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "Greška:", err)
	fmt.Println("Pritisni Enter za izlaz.")
	fmt.Scanln()
	os.Exit(1)
}
