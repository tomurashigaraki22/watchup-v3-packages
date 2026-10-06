// Example: Gin. The WatchUp middleware wraps the engine as an http.Handler;
// Gin's FullPath() supplies the route template.
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	watchup "github.com/tomurashigaraki22/watchup-go-sdk"
)

func main() {
	engine := gin.New()
	engine.Use(gin.Recovery())
	engine.Use(func(c *gin.Context) {
		c.Next()
		// Expose the matched template to WatchUp's Route option.
		c.Request.Header.Set("X-Watchup-Route", c.FullPath())
	})
	engine.GET("/products/:id", func(c *gin.Context) {
		watchup.SetUser(c.Request.Context(), &watchup.User{ID: c.GetHeader("X-User-ID")})
		c.JSON(http.StatusOK, gin.H{"id": c.Param("id")})
	})

	client, err := watchup.New(watchup.Options{
		APIKey: os.Getenv("WATCHUP_API_KEY"),
		Route:  func(r *http.Request) string { return r.Header.Get("X-Watchup-Route") },
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Fatal(http.ListenAndServe(":8080", client.Middleware(engine)))
}
