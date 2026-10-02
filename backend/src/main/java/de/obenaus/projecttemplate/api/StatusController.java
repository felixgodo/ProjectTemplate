package de.obenaus.projecttemplate.api;

import java.util.Map;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.info.BuildProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class StatusController {

    private final String version;

    // BuildProperties gibt es nur nach einem Maven-Lauf (build-info); beim Start aus der IDE fehlen sie.
    public StatusController(ObjectProvider<BuildProperties> build) {
        BuildProperties properties = build.getIfAvailable();
        this.version = properties != null ? properties.getVersion() : "dev";
    }

    @GetMapping("/ping")
    public Map<String, String> ping() {
        return Map.of("status", "ok");
    }

    /** setup.sh prüft nach einem Deploy, dass genau diese Version antwortet. */
    @GetMapping("/version")
    public Map<String, String> version() {
        return Map.of("name", "projecttemplate", "version", version);
    }
}
